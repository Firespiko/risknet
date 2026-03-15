import express from 'express'
import { config } from './config.js'
import { requirePayment, client } from './x402.js'
import { loadAgentIdentity } from './agent-identity.js'
import { isValidWallet, scoreWallet } from './risk-engine.js'

const app = express()
app.use(express.json())

let agentIdentity = {}
loadAgentIdentity().then((id) => {
  agentIdentity = id
})

app.get('/', (req, res) => {
  res.json({
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
      {
        endpoint: 'GET /identity',
        description: 'Read ERC-8004 on-chain identity registration.'
      }
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
})

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: config.agentName,
    chainId: config.chainId,
    x402_enabled: Boolean(config.apiKey && config.apiSecret && config.merchantId),
    etherscan_configured: Boolean(config.etherscanApiKey && !config.etherscanApiKey.includes('<paste')),
    goplus_configured: true,
    checked_at: new Date().toISOString()
  })
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
    res.json({
      ...result,
      payment: req.payment,
      agent: agentIdentity.agentId ? `Agent #${agentIdentity.agentId}` : config.agentName
    })
  } catch (err) {
    res.status(500).json({ error: 'Risk scoring failed', details: err.message })
  }
})

app.listen(config.port, () => {
  console.log(`\n🐐 ${config.agentName} running on :${config.port}\n`)
  console.log(` GET http://localhost:${config.port}/ → agent card`)
  console.log(` GET http://localhost:${config.port}/identity → ERC-8004 identity`)
  console.log(` GET http://localhost:${config.port}/payment/status/:id → x402 order status`)
  console.log(` POST http://localhost:${config.port}/score → ${Number(config.prices.riskScore) / 1e6} ${config.tokenSymbol}`)
  console.log(` Chain: GOAT Testnet3 (${config.chainId})`)
  console.log(` Token: ${config.tokenSymbol} (${config.tokenContract})`)
  console.log(` Merchant: ${config.merchantId || '⚠️ set GOATX402_MERCHANT_ID in .env'}`)
})
