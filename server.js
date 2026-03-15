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

async function fetchEtherscanSignals(wallet) {
  console.log('[RiskNet] Fetching Etherscan data for', wallet);

  if (!ETHERSCAN_API_KEY || ETHERSCAN_API_KEY.includes('<paste your key here>')) {
    console.log('[RiskNet] ETHERSCAN_API_KEY missing or placeholder. Using safe defaults.');
    return { ageDays: 0, txCount: 0 };
  }

  try {
    const url = 'https://api.etherscan.io/api';
    const response = await axios.get(url, {
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
      console.log('[RiskNet] Etherscan returned empty tx list. Using age=0 txCount=0');
      return { ageDays: 0, txCount: 0 };
    }

    const firstTimestamp = Number(result[0]?.timeStamp || 0);
    const ageDays = firstTimestamp
      ? Math.max(0, Math.floor((Date.now() - firstTimestamp * 1000) / 86400000))
      : 0;
    const txCount = result.length;

    console.log('[RiskNet] Etherscan success:', { ageDays, txCount });
    return { ageDays, txCount };
  } catch (error) {
    console.log('[RiskNet] Etherscan failed. Using safe defaults.', error.message);
    return { ageDays: 0, txCount: 0 };
  }
}

async function fetchGoPlusSignals(wallet) {
  console.log('[RiskNet] Fetching GoPlus data for', wallet);
  try {
    const url = `https://api.gopluslabs.io/api/v1/address_security/${wallet}`;
    const response = await axios.get(url, {
      params: { chain_id: 1 },
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
    return flags;
  } catch (error) {
    console.log('[RiskNet] GoPlus failed. Using safe defaults.', error.message);
    return { ...SAFE_DEFAULT_FLAGS };
  }
}

function computeRisk({ ageDays, txCount, flags }) {
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

  return {
    score,
    risk,
    message,
    signals: {
      age_days: ageDays,
      tx_count: txCount,
      sanctioned: flags.is_sanctioned === '1',
      scam_flags: scamFlags
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

  if (!isValidWallet(payerWallet)) {
    console.log('[RiskNet] Wallet invalid before x402 order creation');
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  try {
    const order = await x402Client.createOrder({
      dappOrderId: `risknet-${Date.now()}`,
      chainId: 1,
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
      order_id: order.orderId,
      payment: order.x402 || order,
      message: 'Complete the x402 payment, then retry this request with payment proof headers.'
    });
  } catch (error) {
    console.log('[RiskNet] Failed to create x402 order. Allowing request to continue safely.', error.message);
    return next();
  }
}

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
      --muted: #a1a1aa;
      --border: #27272a;
      --white: #ffffff;
      --green: #22c55e;
      --yellow: #eab308;
      --orange: #f97316;
      --red: #ef4444;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
      background: radial-gradient(circle at top, #171717 0%, var(--bg) 45%);
      color: var(--white);
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
    }
    .wrap {
      width: min(760px, 100%);
      background: rgba(18,18,18,0.95);
      border: 1px solid var(--border);
      border-radius: 24px;
      padding: 32px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.35);
    }
    h1 {
      margin: 0;
      font-size: clamp(2rem, 5vw, 3.4rem);
      line-height: 1;
    }
    .sub {
      color: var(--muted);
      margin-top: 10px;
      margin-bottom: 28px;
      font-size: 1rem;
    }
    .row {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
    }
    input {
      flex: 1 1 420px;
      background: #090909;
      color: var(--white);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 16px 18px;
      font-size: 1rem;
      outline: none;
    }
    button {
      border: none;
      border-radius: 16px;
      padding: 16px 20px;
      background: var(--white);
      color: #0a0a0a;
      font-weight: 700;
      cursor: pointer;
      min-width: 170px;
    }
    button:disabled { opacity: 0.65; cursor: wait; }
    .error {
      color: #fca5a5;
      margin-top: 14px;
      min-height: 24px;
    }
    .result {
      margin-top: 28px;
      display: none;
      border-top: 1px solid var(--border);
      padding-top: 28px;
    }
    .scorebox {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
      margin-bottom: 18px;
    }
    .score {
      font-size: clamp(4rem, 14vw, 7rem);
      line-height: 0.9;
      font-weight: 800;
      letter-spacing: -0.05em;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      padding: 10px 14px;
      border-radius: 999px;
      border: 1px solid currentColor;
      font-weight: 700;
    }
    .msg {
      color: var(--muted);
      margin-bottom: 22px;
      font-size: 1rem;
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
    .signal label {
      color: var(--muted);
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
  </style>
</head>
<body>
  <div class="wrap">
    <h1>RiskNet 🐐</h1>
    <div class="sub">Wallet Fraud Firewall for AI Agents</div>
    <div class="row">
      <input id="wallet" placeholder="0x..." autocomplete="off" spellcheck="false" />
      <button id="checkBtn">Check Risk Score</button>
    </div>
    <div id="error" class="error"></div>
    <div id="result" class="result">
      <div class="scorebox">
        <div id="score" class="score">--</div>
        <div id="badge" class="badge">UNKNOWN</div>
      </div>
      <div id="message" class="msg"></div>
      <div class="signals">
        <div class="signal"><label>Wallet Age</label><div id="sigAge">--</div></div>
        <div class="signal"><label>Transaction Count</label><div id="sigTx">--</div></div>
        <div class="signal"><label>Sanctions Check</label><div id="sigSanctions">--</div></div>
        <div class="signal"><label>Scam Flags</label><div id="sigScam">--</div></div>
      </div>
    </div>
  </div>
  <script>
    const walletInput = document.getElementById('wallet');
    const checkBtn = document.getElementById('checkBtn');
    const errorEl = document.getElementById('error');
    const resultEl = document.getElementById('result');
    const scoreEl = document.getElementById('score');
    const badgeEl = document.getElementById('badge');
    const msgEl = document.getElementById('message');
    const sigAge = document.getElementById('sigAge');
    const sigTx = document.getElementById('sigTx');
    const sigSanctions = document.getElementById('sigSanctions');
    const sigScam = document.getElementById('sigScam');

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

    async function checkRisk() {
      const wallet = walletInput.value.trim();
      errorEl.textContent = '';
      resultEl.style.display = 'none';
      checkBtn.disabled = true;
      checkBtn.innerHTML = '<span class="spinner"></span>Checking...';
      try {
        const response = await fetch('/score', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ wallet })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Something went wrong');
        const color = getColor(data.score);
        scoreEl.textContent = data.score;
        scoreEl.style.color = color;
        badgeEl.textContent = data.risk;
        badgeEl.style.color = color;
        msgEl.textContent = data.message;
        sigAge.textContent = renderSignalAge(data.signals.age_days);
        sigTx.textContent = renderSignalTx(data.signals.tx_count);
        sigSanctions.textContent = data.signals.sanctioned ? 'Sanctioned 🚨' : 'Clear ✅';
        sigScam.textContent = data.signals.scam_flags ? 'Flags found 🚨' : 'No scam flags ✅';
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
  console.log('[RiskNet] /score request received for', wallet);

  if (!isValidWallet(wallet)) {
    console.log('[RiskNet] Invalid wallet address');
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  const [etherscanData, goPlusFlags] = await Promise.all([
    fetchEtherscanSignals(wallet),
    fetchGoPlusSignals(wallet)
  ]);

  const computed = computeRisk({
    ageDays: etherscanData.ageDays,
    txCount: etherscanData.txCount,
    flags: goPlusFlags
  });

  const payload = {
    wallet,
    score: computed.score,
    risk: computed.risk,
    message: computed.message,
    signals: computed.signals,
    checked_at: new Date().toISOString()
  };

  console.log('[RiskNet] Score computed:', payload);
  return res.json(payload);
});

app.listen(PORT, () => {
  console.log(`[RiskNet] Server running on http://localhost:${PORT}`);
});
