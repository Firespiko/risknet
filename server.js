import express from 'express'
import { config } from './config.js'
import { requirePayment, client } from './x402.js'
import { loadAgentIdentity } from './agent-identity.js'
import { isValidWallet, scoreWallet } from './risk-engine.js'
import { getActivity, recordReport } from './activity-store.js'

const app = express()
app.use(express.json())

let agentIdentity = {}
loadAgentIdentity().then((id) => {
  agentIdentity = id
})

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function renderDashboard() {
  const activity = getActivity()
  const orders = activity.orders.slice(0, 10)
  const payments = activity.payments.slice(0, 10)
  const reports = activity.reports.slice(0, 10)

  const rows = (items, render) => items.length ? items.map(render).join('') : '<div class="empty">No events yet.</div>'

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>GOAT RiskNet Agent Dashboard</title>
<style>
body{background:#0a0a0a;color:#fff;font-family:Inter,system-ui,sans-serif;margin:0;padding:24px}
.wrap{max-width:1200px;margin:0 auto}.hero{display:flex;justify-content:space-between;gap:20px;flex-wrap:wrap;margin-bottom:24px}
.card{background:#121212;border:1px solid #27272a;border-radius:18px;padding:18px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:18px}
.muted{color:#a1a1aa}.pill{display:inline-block;padding:6px 10px;border:1px solid #3f3f46;border-radius:999px;margin:4px 6px 0 0}.item{padding:12px 0;border-top:1px solid #27272a}.item:first-child{border-top:none}.mono{font-family:ui-monospace,SFMono-Regular,monospace;font-size:12px;word-break:break-all}.good{color:#22c55e}.warn{color:#eab308}.bad{color:#ef4444}.empty{color:#71717a;padding:8px 0}
a{color:#60a5fa;text-decoration:none}
</style>
</head>
<body>
<div class="wrap">
  <div class="hero card">
    <div>
      <h1 style="margin:0 0 8px">🐐 GOAT RiskNet Agent</h1>
      <div class="muted">Get paid via x402, calculate wallet risk, return the report back.</div>
      <div style="margin-top:12px">
        <span class="pill">Agent #${esc(agentIdentity.agentId || 'unregistered')}</span>
        <span class="pill">Token ${esc(config.tokenSymbol)}</span>
        <span class="pill">Price ${Number(config.prices.riskScore) / 1e6} ${esc(config.tokenSymbol)}</span>
        <span class="pill">Chain ${esc(config.chainId)}</span>
      </div>
    </div>
    <div>
      <div class="muted">Wallet</div>
      <div class="mono">${esc(config.agentWalletAddress)}</div>
      <div class="muted" style="margin-top:8px">Registry</div>
      <div class="mono">${esc(config.identityRegistry)}</div>
    </div>
  </div>

  <div class="grid">
    <div class="card">
      <h3>Recent Orders</h3>
      ${rows(orders, (o) => `<div class="item"><div><strong>${esc(o.status || 'ORDER')}</strong> · ${esc(o.tokenSymbol)} ${Number(o.amountWei||0)/1e6}</div><div class="mono">order ${esc(o.orderId)}</div><div class="mono">to ${esc(o.payToAddress)}</div><div class="muted">${esc(o.at)}</div></div>`) }
    </div>

    <div class="card">
      <h3>Recent Payment States</h3>
      ${rows(payments, (p) => `<div class="item"><div><strong class="${p.status === 'PAYMENT_CONFIRMED' || p.status === 'INVOICED' ? 'good' : p.status === 'CHECKOUT_VERIFIED' ? 'warn' : 'bad'}">${esc(p.status || 'UNKNOWN')}</strong></div><div class="mono">order ${esc(p.orderId)}</div><div class="mono">tx ${esc(p.txHash || '—')}</div><div class="muted">${esc(p.at)}</div></div>`) }
    </div>

    <div class="card">
      <h3>Recent Risk Reports</h3>
      ${rows(reports, (r) => `<div class="item"><div><strong>${esc(r.risk)}</strong> / ${esc(r.action)} / confidence ${esc(r.confidence)}</div><div class="mono">wallet ${esc(r.wallet)}</div><div>score ${esc(r.score)}</div><div class="muted">${esc(r.at)}</div></div>`) }
    </div>
  </div>

  <div class="card" style="margin-top:18px">
    <h3>API</h3>
    <div class="mono">GET /identity</div>
    <div class="mono">GET /health</div>
    <div class="mono">GET /activity</div>
    <div class="mono">GET /payment/status/:orderId</div>
    <div class="mono">POST /score</div>
  </div>
</div>
</body>
</html>`
}

app.get('/', (req, res) => {
  const wantsJson = req.query.format === 'json' || String(req.get('accept') || '').includes('application/json')
  if (wantsJson) {
    return res.json({
      agent: `🐐 ${config.agentName}`,
      description: config.agentDescription,
      identity: agentIdentity.registered
        ? {
            agentId: agentIdentity.agentId,
            agentRegistry: agentIdentity.agentRegistry,
            name: agentIdentity.registrationFile?.name,
            owner: agentIdentity.owner,
            wallet: agentIdentity.wallet
          }
        : { registered: false, hint: 'Run npm run register-agent after funding the agent wallet.' },
      services: [
        {
          endpoint: 'POST /score',
          description: 'Score a wallet for scam / fraud risk before a GOAT agent sends funds.',
          price: `${Number(config.prices.riskScore) / 1e6} ${config.tokenSymbol}`,
          chain: `GOAT Testnet3 (${config.chainId})`,
          how: 'POST without X-Order-ID to receive a 402 order. Pay on-chain, then retry with X-Order-ID.'
        },
        { endpoint: 'GET /identity', description: 'Read ERC-8004 on-chain identity registration.' }
      ],
      x402Support: Boolean(config.apiKey && config.apiSecret && config.merchantId),
      network: {
        chainId: config.chainId,
        chainSlug: config.chainSlug,
        token: config.tokenSymbol,
        contract: config.tokenContract,
        rpc: config.rpcUrl,
        explorer: config.explorerUrl
      }
    })
  }

  res.type('html').send(renderDashboard())
})

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: config.agentName,
    chainId: config.chainId,
    x402_enabled: Boolean(config.apiKey && config.apiSecret && config.merchantId),
    etherscan_configured: Boolean(config.etherscanApiKey && !config.etherscanApiKey.includes('<paste')),
    goplus_configured: Boolean(config.goplusAppKey),
    checked_at: new Date().toISOString()
  })
})

app.get('/activity', (req, res) => {
  res.json(getActivity())
})

app.get('/identity', async (req, res) => {
  const identity = await loadAgentIdentity()
  res.json(identity)
})

app.get('/payment/status/:orderId', async (req, res) => {
  try {
    const status = await client.getOrderStatus(req.params.orderId)
    res.json(status)
  } catch (err) {
    res.status(404).json({ error: err.message })
  }
})

app.post('/score', requirePayment(config.prices.riskScore), async (req, res) => {
  const wallet = String(req.body?.wallet || '').trim()

  if (!isValidWallet(wallet)) {
    return res.status(400).json({ error: 'Invalid wallet address' })
  }

  try {
    const result = await scoreWallet(wallet)
    const payload = {
      ...result,
      payment: req.payment,
      agent: agentIdentity.agentId ? `Agent #${agentIdentity.agentId}` : config.agentName
    }
    recordReport({ wallet, score: result.score, risk: result.risk, action: result.action, confidence: result.confidence })
    res.json(payload)
  } catch (err) {
    res.status(500).json({ error: 'Risk scoring failed', details: err.message })
  }
})

app.listen(config.port, () => {
  console.log(`\n🐐 ${config.agentName} running on :${config.port}\n`)
  console.log(` GET http://localhost:${config.port}/ → dashboard / agent card`)
  console.log(` GET http://localhost:${config.port}/identity → ERC-8004 identity`)
  console.log(` GET http://localhost:${config.port}/activity → order/payment/report feed`)
  console.log(` GET http://localhost:${config.port}/payment/status/:id → x402 order status`)
  console.log(` POST http://localhost:${config.port}/score → ${Number(config.prices.riskScore) / 1e6} ${config.tokenSymbol}`)
  console.log(` Chain: GOAT Testnet3 (${config.chainId})`)
  console.log(` Token: ${config.tokenSymbol} (${config.tokenContract})`)
  console.log(` Merchant: ${config.merchantId || '⚠️ set GOATX402_MERCHANT_ID in .env'}`)
})
