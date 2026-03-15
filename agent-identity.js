import { ethers } from 'ethers'
import { config } from './config.js'

const IDENTITY_REGISTRY_ABI = [
  'function register(string agentURI) returns (uint256 agentId)',
  'function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes calldata signature) external',
  'function getAgentWallet(uint256 agentId) external view returns (address)',
  'function tokenURI(uint256 agentId) external view returns (string)',
  'function ownerOf(uint256 agentId) external view returns (address)',
  'event Registered(uint256 indexed agentId, string agentURI, address indexed owner)'
]

let provider
let registry
let agentInfo = null

function getProvider() {
  if (!provider) provider = new ethers.JsonRpcProvider(config.rpcUrl)
  return provider
}

function getRegistry(signer) {
  if (signer) return new ethers.Contract(config.identityRegistry, IDENTITY_REGISTRY_ABI, signer)
  if (!registry) registry = new ethers.Contract(config.identityRegistry, IDENTITY_REGISTRY_ABI, getProvider())
  return registry
}

export async function loadAgentIdentity() {
  if (agentInfo) return agentInfo

  const agentId = config.agentId
  if (!agentId) {
    agentInfo = { registered: false, hint: 'Set AGENT_ID after running npm run register-agent' }
    return agentInfo
  }

  try {
    const reg = getRegistry()
    const [owner, wallet, uri] = await Promise.all([
      reg.ownerOf(agentId).catch(() => null),
      reg.getAgentWallet(agentId).catch(() => null),
      reg.tokenURI(agentId).catch(() => null)
    ])

    let registrationFile = null
    if (uri && uri.startsWith('data:application/json;base64,')) {
      const json = Buffer.from(uri.split(',')[1], 'base64').toString('utf-8')
      registrationFile = JSON.parse(json)
    }

    agentInfo = {
      registered: true,
      agentId: String(agentId),
      agentRegistry: `eip155:${config.chainId}:${config.identityRegistry}`,
      owner,
      wallet,
      registrationFile
    }

    console.log(`[8004] Agent #${agentId} loaded — owner: ${owner}`)
    return agentInfo
  } catch (err) {
    console.warn('[8004] Could not load agent identity:', err.message)
    agentInfo = { registered: false, error: err.message }
    return agentInfo
  }
}

export async function registerAgent(name, description, serviceEndpoint) {
  if (!config.agentPrivateKey) throw new Error('AGENT_PRIVATE_KEY not set in .env')

  const wallet = new ethers.Wallet(config.agentPrivateKey, getProvider())
  const reg = getRegistry(wallet)

  const registrationFile = {
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name,
    description,
    services: [{ name: 'risknet', endpoint: serviceEndpoint }],
    x402Support: true,
    active: true,
    registrations: [
      {
        agentId: 0,
        agentRegistry: `eip155:${config.chainId}:${config.identityRegistry}`
      }
    ],
    supportedTrust: ['reputation']
  }

  const b64 = Buffer.from(JSON.stringify(registrationFile)).toString('base64')
  const agentURI = `data:application/json;base64,${b64}`

  console.log('[8004] Registering agent on GOAT Network...')
  console.log('[8004] Wallet:', wallet.address)

  const tx = await reg.register(agentURI)
  console.log('[8004] TX sent:', tx.hash)

  const receipt = await tx.wait()
  const event = receipt.logs
    .map((log) => {
      try {
        return reg.interface.parseLog(log)
      } catch {
        return null
      }
    })
    .find((entry) => entry?.name === 'Registered')

  const agentId = event?.args?.agentId?.toString() || 'unknown'
  console.log(`[8004] ✅ Agent registered! Agent ID: #${agentId}`)
  console.log(`[8004] Add to .env: AGENT_ID=${agentId}`)

  agentInfo = null
  return { agentId, txHash: tx.hash, agentURI }
}
