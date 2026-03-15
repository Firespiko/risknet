import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';
import { GoatX402Client } from 'goatx402-sdk-server';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || '';
const X402_BASE_URL = process.env.GOATX402_BASE_URL || 'https://api.goatx402.io';
const X402_MERCHANT_ID = process.env.GOATX402_MERCHANT_ID || '';
const USDC_ATOMIC_AMOUNT = '20000';

const CHAIN_CONFIG = {
  ethereum: {
    label: 'Ethereum',
    etherscanEnabled: true,
    etherscanApiBase: 'https://api.etherscan.io/api',
    goplusChainId: 1,
    x402ChainId: 1,
    note: 'Ethereum mainnet scoring with Etherscan and GoPlus.'
  },
  goat: {
    label: 'Goat Network',
    etherscanEnabled: false,
    etherscanApiBase: null,
    goplusChainId: 1,
    x402ChainId: 1,
    note:
      'Goat mode uses the same EVM-style wallet format. Explorer-specific scoring can be upgraded later when a dedicated Goat data source is available.'
  }
};

const x402Client =
  process.env.GOATX402_API_KEY && process.env.GOATX402_API_SECRET
    ? new GoatX402Client({
        baseUrl: X402_BASE_URL,
        apiKey: process.env.GOATX402_API_KEY,
        apiSecret: process.env.GOATX402_API_SECRET
      })
    : null;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const SAFE_DEFAULT_FLAGS = {
  is_sanctioned: '0',
  blackmail_activities: '0',
  stealing_attack: '0',
  honeypot_related_address: '0'
};

function isValidWallet(wallet) {
  return /^0x[a-fA-F0-9]{40}$/.test(wallet || '');
}

function normalizeChain(chain) {
  const normalized = String(chain || 'ethereum').trim().toLowerCase();
  return CHAIN_CONFIG[normalized] ? normalized : 'ethereum';
}

function scoreFromWalletAge(ageDays) {
  if (ageDays > 365) return 5;
  if (ageDays > 180) return 15;
  if (ageDays > 90) return 30;
  if (ageDays > 30) return 55;
  if (ageDays > 7) return 75;
  return 90;
}

function scoreFromTxCount(count) {
  if (count > 500) return 5;
  if (count > 100) return 15;
  if (count > 50) return 25;
  if (count > 20) return 40;
  if (count > 5) return 60;
  return 85;
}

function getRiskLevel(score) {
  if (score <= 30) return 'LOW';
  if (score <= 60) return 'MEDIUM';
  if (score <= 80) return 'HIGH';
  return 'CRITICAL';
}

function getRiskMessage(risk) {
  switch (risk) {
    case 'LOW':
      return 'Clean wallet. Safe to transact.';
    case 'MEDIUM':
      return 'Some risk detected. Proceed with caution.';
    case 'HIGH':
      return 'High risk wallet. Verify before sending funds.';
    default:
      return 'DANGER: Do not transact with this wallet.';
  }
}

function getAction(score) {
  if (score <= 30) return 'ALLOW';
  if (score <= 60) return 'REVIEW';
  return 'BLOCK';
}

function buildReasons({ ageDays, txCount, flags, chain, usedSafeDefaults }) {
  const reasons = [];

  if (ageDays > 365) reasons.push(`Wallet is ${ageDays} days old, which lowers risk.`);
  else if (ageDays > 90) reasons.push(`Wallet is ${ageDays} days old, giving it moderate history.`);
  else if (ageDays > 7) reasons.push(`Wallet is only ${ageDays} days old, which raises risk.`);
  else reasons.push(`Wallet is extremely new (${ageDays} days old), which is a strong risk signal.`);

  if (txCount > 500) reasons.push(`Wallet has a deep transaction history (${txCount} tx), which lowers risk.`);
  else if (txCount > 50) reasons.push(`Wallet has a reasonable transaction history (${txCount} tx).`);
  else if (txCount > 5) reasons.push(`Wallet has limited history (${txCount} tx), so confidence is lower.`);
  else reasons.push(`Wallet has almost no transaction history (${txCount} tx), which is suspicious.`);

  if (flags.is_sanctioned === '1') {
    reasons.push('Sanctions-related signal detected. This is a severe risk factor.');
  }

  if (flags.blackmail_activities === '1') {
    reasons.push('Blackmail-related activity flag detected.');
  }

  if (flags.stealing_attack === '1') {
    reasons.push('Stealing-attack signal detected.');
  }

  if (flags.honeypot_related_address === '1') {
    reasons.push('Honeypot-related signal detected.');
  }

  if (chain === 'goat') {
    reasons.push('Goat mode currently reuses EVM-compatible heuristics while waiting for Goat-specific explorer data.');
  }

  if (usedSafeDefaults) {
    reasons.push('Some external data sources were unavailable, so safe defaults were used for part of the analysis.');
  }

  return reasons;
}

async function fetchEtherscanSignals(wallet, chain) {
  const config = CHAIN_CONFIG[chain];
  console.log('[RiskNet] Fetching explorer data for', wallet, 'on', chain);

  if (!config.etherscanEnabled) {
    console.log('[RiskNet] No explorer integration configured for this chain yet. Using safe defaults.');
    return { ageDays: 0, txCount: 0, usedSafeDefaults: true };
  }

  if (!ETHERSCAN_API_KEY || ETHERSCAN_API_KEY.includes('<paste your key here>')) {
    console.log('[RiskNet] ETHERSCAN_API_KEY missing or placeholder. Using safe defaults.');
    return { ageDays: 0, txCount: 0, usedSafeDefaults: true };
  }

  try {
    const response = await axios.get(config.etherscanApiBase, {
      params: {
        module: 'account',
        action: 'txlist',
        address: wallet,
        startblock: 0,
        endblock: 99999999,
        sort: 'asc',
        apikey: ETHERSCAN_API_KEY
      },
      timeout: 15000
    });

    const result = Array.isArray(response.data?.result) ? response.data.result : [];

    if (!result.length) {
      console.log('[RiskNet] Explorer returned empty tx list. Using age=0 txCount=0');
      return { ageDays: 0, txCount: 0, usedSafeDefaults: true };
    }

    const firstTimestamp = Number(result[0]?.timeStamp || 0);
    const ageDays = firstTimestamp
      ? Math.max(0, Math.floor((Date.now() - firstTimestamp * 1000) / 86400000))
      : 0;
    const txCount = result.length;

    console.log('[RiskNet] Explorer success:', { ageDays, txCount });
    return { ageDays, txCount, usedSafeDefaults: false };
  } catch (error) {
    console.log('[RiskNet] Explorer lookup failed. Using safe defaults.', error.message);
    return { ageDays: 0, txCount: 0, usedSafeDefaults: true };
  }
}

async function fetchGoPlusSignals(wallet, chain) {
  const config = CHAIN_CONFIG[chain];
  console.log('[RiskNet] Fetching GoPlus data for', wallet, 'on', chain);

  try {
    const url = `https://api.gopluslabs.io/api/v1/address_security/${wallet}`;
    const response = await axios.get(url, {
      params: { chain_id: config.goplusChainId },
      timeout: 15000
    });

    const data = response.data?.result || response.data?.data || {};
    const flags = {
      is_sanctioned: data.is_sanctioned ?? SAFE_DEFAULT_FLAGS.is_sanctioned,
      blackmail_activities: data.blackmail_activities ?? SAFE_DEFAULT_FLAGS.blackmail_activities,
      stealing_attack: data.stealing_attack ?? SAFE_DEFAULT_FLAGS.stealing_attack,
      honeypot_related_address: data.honeypot_related_address ?? SAFE_DEFAULT_FLAGS.honeypot_related_address
    };

    console.log('[RiskNet] GoPlus success:', flags);
    return { flags, usedSafeDefaults: false };
  } catch (error) {
    console.log('[RiskNet] GoPlus failed. Using safe defaults.', error.message);
    return { flags: { ...SAFE_DEFAULT_FLAGS }, usedSafeDefaults: true };
  }
}

function computeRisk({ ageDays, txCount, flags, chain, dataUsedSafeDefaults }) {
  const walletAgeScore = scoreFromWalletAge(ageDays);
  const txCountScore = scoreFromTxCount(txCount);
  const sanctionsScore = flags.is_sanctioned === '1' ? 100 : 0;
  const scamFlags =
    flags.blackmail_activities === '1' ||
    flags.stealing_attack === '1' ||
    flags.honeypot_related_address === '1';
  const scamScore = scamFlags ? 100 : 0;

  const score = Math.round(
    walletAgeScore * 0.25 +
      txCountScore * 0.2 +
      sanctionsScore * 0.35 +
      scamScore * 0.2
  );

  const risk = getRiskLevel(score);
  const message = getRiskMessage(risk);
  const action = getAction(score);
  const reasons = buildReasons({
    ageDays,
    txCount,
    flags,
    chain,
    usedSafeDefaults: dataUsedSafeDefaults
  });

  return {
    score,
    risk,
    action,
    message,
    reasons,
    signals: {
      age_days: ageDays,
      tx_count: txCount,
      sanctioned: flags.is_sanctioned === '1',
      scam_flags: scamFlags,
      chain_supported: true,
      used_safe_defaults: dataUsedSafeDefaults
    }
  };
}

async function withX402Gate(req, res, next) {
  console.log('[RiskNet] Entering x402 payment gate');

  if (!x402Client || !X402_MERCHANT_ID) {
    console.log('[RiskNet] x402 config missing. Skipping gate without crashing.');
    return next();
  }

  const paymentHeader = req.get('x-payment') || req.get('x-x402-payment') || req.get('authorization');
  const orderIdHeader = req.get('x-order-id') || req.get('x-x402-order-id');

  if (paymentHeader && orderIdHeader) {
    try {
      console.log('[RiskNet] Payment proof headers found. Checking order status for', orderIdHeader);
      const order = await x402Client.getOrderStatus(orderIdHeader);
      console.log('[RiskNet] x402 order status:', order.status);

      if (['PAYMENT_CONFIRMED', 'INVOICED'].includes(order.status)) {
        req.x402 = { orderId: orderIdHeader, status: order.status, paymentHeaderPresent: true };
        return next();
      }

      console.log('[RiskNet] Payment not confirmed yet, issuing 402 challenge');
    } catch (error) {
      console.log('[RiskNet] Failed to verify supplied x402 order. Issuing fresh challenge.', error.message);
    }
  }

  const payerWallet = String(req.body?.wallet || '').trim();
  const chain = normalizeChain(req.body?.chain);

  if (!isValidWallet(payerWallet)) {
    console.log('[RiskNet] Wallet invalid before x402 order creation');
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  try {
    const order = await x402Client.createOrder({
      dappOrderId: `risknet-${Date.now()}`,
      chainId: CHAIN_CONFIG[chain].x402ChainId,
      tokenSymbol: 'USDC',
      fromAddress: payerWallet,
      amountWei: USDC_ATOMIC_AMOUNT
    });

    console.log('[RiskNet] x402 order created:', order.orderId);

    return res.status(402).json({
      error: 'Payment required',
      merchant_id: X402_MERCHANT_ID,
      amount: '0.02',
      asset: 'USDC',
      chain,
      order_id: order.orderId,
      payment: order.x402 || order,
      message: 'Complete the x402 payment, then retry this request with payment proof headers.'
    });
  } catch (error) {
    console.log('[RiskNet] Failed to create x402 order. Allowing request to continue safely.', error.message);
    return next();
  }
}

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'RiskNet',
    chains: Object.keys(CHAIN_CONFIG),
    x402_enabled: Boolean(x402Client && X402_MERCHANT_ID),
    etherscan_configured: Boolean(
      ETHERSCAN_API_KEY && !ETHERSCAN_API_KEY.includes('<paste your key here>')
    ),
    checked_at: new Date().toISOString()
  });
});

app.get('/', (req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>RiskNet 🐐</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0a0a0a;
      --panel: #121212;
      --panel-2: #18181b;
      --muted: #a1a1aa;
      --border: #27272a;
      --white: #ffffff;
      --green: #22c55e;
      --yellow: #eab308;
      --orange: #f97316;
      --red: #ef4444;
      --blue: #60a5fa;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
      background: radial-gradient(circle at top, #161616 0%, var(--bg) 48%);
      color: var(--white);
      min-height: 100vh;
      padding: 24px;
    }
    .wrap {
      width: min(980px, 100%);
      margin: 0 auto;
      background: rgba(18,18,18,0.94);
      border: 1px solid var(--border);
      border-radius: 24px;
      padding: 32px;
      box-shadow: 0 24px 80px rgba(0,0,0,0.45);
    }
    h1 {
      margin: 0;
      font-size: clamp(2.3rem, 5vw, 3.8rem);
      line-height: 1;
    }
    .sub {
      color: var(--muted);
      margin-top: 10px;
      margin-bottom: 26px;
      font-size: 1.02rem;
      max-width: 760px;
    }
    .hero-grid {
      display: grid;
      grid-template-columns: 1.3fr 0.7fr;
      gap: 18px;
      margin-bottom: 24px;
    }
    .mini-card, .panel {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 18px;
      padding: 18px;
    }
    .mini-card h3, .panel h3 {
      margin: 0 0 10px;
      font-size: 0.95rem;
      color: var(--muted);
      font-weight: 600;
      letter-spacing: 0.02em;
      text-transform: uppercase;
    }
    .mini-card p {
      margin: 0;
      color: var(--white);
      line-height: 1.5;
    }
    .controls {
      display: grid;
      gap: 12px;
      margin-top: 20px;
    }
    .row {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
    }
    input, select {
      flex: 1 1 320px;
      background: #090909;
      color: var(--white);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 15px 16px;
      font-size: 1rem;
      outline: none;
    }
    button {
      border: none;
      border-radius: 14px;
      padding: 15px 20px;
      background: var(--white);
      color: #0a0a0a;
      font-weight: 800;
      cursor: pointer;
      min-width: 180px;
    }
    button:disabled { opacity: 0.7; cursor: wait; }
    .error {
      color: #fca5a5;
      min-height: 24px;
      margin-top: 6px;
    }
    .result {
      display: none;
      margin-top: 26px;
      gap: 18px;
    }
    .score-panel {
      display: grid;
      grid-template-columns: 0.9fr 1.1fr;
      gap: 18px;
    }
    .score-box {
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      min-height: 260px;
    }
    .score {
      font-size: clamp(4rem, 12vw, 7rem);
      line-height: 0.9;
      font-weight: 900;
      letter-spacing: -0.05em;
    }
    .badge-row {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-top: 12px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      padding: 10px 14px;
      border-radius: 999px;
      border: 1px solid currentColor;
      font-weight: 800;
      font-size: 0.9rem;
    }
    .message {
      color: var(--muted);
      margin-top: 14px;
      line-height: 1.5;
    }
    .signals {
      display: grid;
      gap: 12px;
    }
    .signal {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      padding: 14px 16px;
      border: 1px solid var(--border);
      border-radius: 14px;
      background: #0d0d0d;
    }
    .signal label { color: var(--muted); }
    .reasons {
      margin: 0;
      padding-left: 18px;
      color: var(--white);
      line-height: 1.6;
    }
    .reasons li + li { margin-top: 8px; }
    .footer-note {
      margin-top: 18px;
      color: var(--muted);
      font-size: 0.95rem;
    }
    .code {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      color: var(--blue);
    }
    .spinner {
      display: inline-block;
      width: 18px;
      height: 18px;
      border: 2px solid rgba(255,255,255,0.25);
      border-top-color: #0a0a0a;
      border-radius: 999px;
      animation: spin 1s linear infinite;
      vertical-align: middle;
      margin-right: 8px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (max-width: 820px) {
      .hero-grid, .score-panel { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>RiskNet 🐐</h1>
    <div class="sub">Wallet Fraud Firewall for AI Agents — chain-aware, Goat-native in spirit, and built to score a wallet before funds move.</div>

    <div class="hero-grid">
      <div class="mini-card">
        <h3>What this does</h3>
        <p>Scores an EVM wallet from <strong>0-100</strong>, returns a risk level, a recommended action, and human-readable reasons. Useful for AI agents, demos, and payment safety checks.</p>
      </div>
      <div class="mini-card">
        <h3>Supported chains</h3>
        <p><strong>Ethereum</strong> and <strong>Goat</strong> mode. Goat addresses still use the normal <span class="code">0x...</span> EVM format.</p>
      </div>
    </div>

    <div class="controls">
      <div class="row">
        <input id="wallet" placeholder="0x..." autocomplete="off" spellcheck="false" />
        <select id="chain">
          <option value="ethereum">Ethereum</option>
          <option value="goat">Goat</option>
        </select>
        <button id="checkBtn">Check Risk Score</button>
      </div>
      <div id="error" class="error"></div>
    </div>

    <div id="result" class="result">
      <div class="score-panel">
        <div class="panel score-box">
          <div>
            <div id="score" class="score">--</div>
            <div class="badge-row">
              <div id="badge" class="badge">UNKNOWN</div>
              <div id="action" class="badge">ACTION</div>
              <div id="chainBadge" class="badge">CHAIN</div>
            </div>
            <div id="message" class="message"></div>
          </div>
          <div class="footer-note">Designed for agent payment pre-checks. High score = more risky.</div>
        </div>

        <div class="panel">
          <h3>Signal Breakdown</h3>
          <div class="signals">
            <div class="signal"><label>Wallet Age</label><div id="sigAge">--</div></div>
            <div class="signal"><label>Transaction Count</label><div id="sigTx">--</div></div>
            <div class="signal"><label>Sanctions Check</label><div id="sigSanctions">--</div></div>
            <div class="signal"><label>Scam Flags</label><div id="sigScam">--</div></div>
            <div class="signal"><label>Safe Defaults Used</label><div id="sigDefaults">--</div></div>
          </div>
        </div>
      </div>

      <div class="panel" style="margin-top:18px;">
        <h3>Why this score happened</h3>
        <ul id="reasons" class="reasons"></ul>
      </div>
    </div>
  </div>

  <script>
    const walletInput = document.getElementById('wallet');
    const chainInput = document.getElementById('chain');
    const checkBtn = document.getElementById('checkBtn');
    const errorEl = document.getElementById('error');
    const resultEl = document.getElementById('result');
    const scoreEl = document.getElementById('score');
    const badgeEl = document.getElementById('badge');
    const actionEl = document.getElementById('action');
    const chainBadgeEl = document.getElementById('chainBadge');
    const msgEl = document.getElementById('message');
    const sigAge = document.getElementById('sigAge');
    const sigTx = document.getElementById('sigTx');
    const sigSanctions = document.getElementById('sigSanctions');
    const sigScam = document.getElementById('sigScam');
    const sigDefaults = document.getElementById('sigDefaults');
    const reasonsEl = document.getElementById('reasons');

    function getColor(score) {
      if (score <= 30) return '#22c55e';
      if (score <= 60) return '#eab308';
      if (score <= 80) return '#f97316';
      return '#ef4444';
    }

    function iconForState(kind) {
      if (kind === 'good') return '✅';
      if (kind === 'warn') return '⚠️';
      return '🚨';
    }

    function renderSignalAge(days) {
      const kind = days > 180 ? 'good' : days > 30 ? 'warn' : 'bad';
      return days + ' days ' + iconForState(kind);
    }

    function renderSignalTx(count) {
      const kind = count > 100 ? 'good' : count > 20 ? 'warn' : 'bad';
      return count + ' tx ' + iconForState(kind);
    }

    function renderReasonList(reasons) {
      reasonsEl.innerHTML = '';
      reasons.forEach((reason) => {
        const li = document.createElement('li');
        li.textContent = reason;
        reasonsEl.appendChild(li);
      });
    }

    async function checkRisk() {
      const wallet = walletInput.value.trim();
      const chain = chainInput.value;
      errorEl.textContent = '';
      resultEl.style.display = 'none';
      checkBtn.disabled = true;
      checkBtn.innerHTML = '<span class="spinner"></span>Checking...';

      try {
        const response = await fetch('/score', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ wallet, chain })
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || data.message || 'Something went wrong');
        }

        const color = getColor(data.score);
        scoreEl.textContent = data.score;
        scoreEl.style.color = color;
        badgeEl.textContent = data.risk;
        badgeEl.style.color = color;
        actionEl.textContent = data.action;
        actionEl.style.color = color;
        chainBadgeEl.textContent = String(data.chain || chain).toUpperCase();
        chainBadgeEl.style.color = '#60a5fa';
        msgEl.textContent = data.message;
        sigAge.textContent = renderSignalAge(data.signals.age_days);
        sigTx.textContent = renderSignalTx(data.signals.tx_count);
        sigSanctions.textContent = data.signals.sanctioned ? 'Sanctioned 🚨' : 'Clear ✅';
        sigScam.textContent = data.signals.scam_flags ? 'Flags found 🚨' : 'No scam flags ✅';
        sigDefaults.textContent = data.signals.used_safe_defaults ? 'Yes ⚠️' : 'No ✅';
        renderReasonList(data.reasons || []);
        resultEl.style.display = 'block';
      } catch (error) {
        errorEl.textContent = error.message || 'Failed to check wallet risk';
      } finally {
        checkBtn.disabled = false;
        checkBtn.textContent = 'Check Risk Score';
      }
    }

    checkBtn.addEventListener('click', checkRisk);
    walletInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') checkRisk();
    });
  </script>
</body>
</html>`);
});

app.post('/score', withX402Gate, async (req, res) => {
  const wallet = String(req.body?.wallet || '').trim();
  const chain = normalizeChain(req.body?.chain);
  console.log('[RiskNet] /score request received for', wallet, 'on', chain);

  if (!isValidWallet(wallet)) {
    console.log('[RiskNet] Invalid wallet address');
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  const [explorerData, goPlusData] = await Promise.all([
    fetchEtherscanSignals(wallet, chain),
    fetchGoPlusSignals(wallet, chain)
  ]);

  const dataUsedSafeDefaults = explorerData.usedSafeDefaults || goPlusData.usedSafeDefaults;

  const computed = computeRisk({
    ageDays: explorerData.ageDays,
    txCount: explorerData.txCount,
    flags: goPlusData.flags,
    chain,
    dataUsedSafeDefaults
  });

  const payload = {
    wallet,
    chain,
    score: computed.score,
    risk: computed.risk,
    action: computed.action,
    message: computed.message,
    reasons: computed.reasons,
    signals: computed.signals,
    checked_at: new Date().toISOString()
  };

  console.log('[RiskNet] Score computed:', payload);
  return res.json(payload);
});

app.listen(PORT, () => {
  console.log(`[RiskNet] Server running on http://localhost:${PORT}`);
});
