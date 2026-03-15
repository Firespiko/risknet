import 'dotenv/config'
import { registerAgent } from './agent-identity.js'
import { config } from './config.js'

if (!config.agentPrivateKey) {
  console.error('❌ AGENT_PRIVATE_KEY not set in .env')
  process.exit(1)
}

const SERVICE_ENDPOINT = process.env.SERVICE_ENDPOINT || `http://localhost:${config.port}`

console.log('🐐 Registering agent on GOAT Network ERC-8004...')
console.log(`Registry: ${config.identityRegistry}`)
console.log(`Wallet: ${config.agentWalletAddress}`)
console.log(`Endpoint: ${SERVICE_ENDPOINT}`)
console.log()

registerAgent(config.agentName, config.agentDescription, SERVICE_ENDPOINT)
  .then(({ agentId, txHash }) => {
    console.log('\n✅ Registration complete!')
    console.log(`Agent ID: ${agentId}`)
    console.log(`TX Hash: ${txHash}`)
    console.log('\n👉 Add this to your .env:')
    console.log(`AGENT_ID=${agentId}`)
  })
  .catch((err) => {
    console.error('❌ Registration failed:', err.message)
    if (err.message.includes('insufficient funds')) {
      console.error('Need BTC for gas → https://bridge.testnet3.goat.network/faucet')
    }
    process.exit(1)
  })
