import 'dotenv/config'
import { ethers } from 'ethers'

const agentPrivateKey = process.env.AGENT_PRIVATE_KEY || ''
const derivedWallet = agentPrivateKey ? new ethers.Wallet(agentPrivateKey).address : ''

export const config = {
  apiUrl: process.env.GOATX402_API_URL || 'https://x402-api-lx58aabp0r.testnet3.goat.network',
  merchantId: process.env.GOATX402_MERCHANT_ID || '',
  apiKey: process.env.GOATX402_API_KEY || '',
  apiSecret: process.env.GOATX402_API_SECRET || '',

  agentPrivateKey,
  agentWalletAddress: process.env.AGENT_WALLET_ADDRESS || derivedWallet,
  agentId: process.env.AGENT_ID || '',

  port: parseInt(process.env.PORT || '3000', 10),

  prices: {
    riskScore: process.env.PRICE_PER_RISK_SCORE || '20000',
    echo: process.env.PRICE_PER_ECHO || '10000'
  },

  chainId: 48816,
  chainSlug: 'goat-testnet',
  tokenSymbol: process.env.GOAT_TOKEN_SYMBOL || 'USDC',
  tokenContract: process.env.GOAT_USDC_TOKEN_CONTRACT || '0x29d1ee93e9ecf6e50f309f498e40a6b42d352fa1',
  identityRegistry: process.env.GOAT_IDENTITY_REGISTRY || '0x556089008Fc0a60cD09390Eca93477ca254A5522',
  rpcUrl: process.env.GOAT_RPC_URL || 'https://rpc.testnet3.goat.network',
  explorerUrl: process.env.GOAT_EXPLORER_URL || 'https://explorer.testnet3.goat.network',

  etherscanApiKey: process.env.ETHERSCAN_API_KEY || '',
  goplusApiBase: process.env.GOPLUS_API_BASE || 'https://api.gopluslabs.io/api/v1',
  goplusAppKey: process.env.GOPLUS_APP_KEY || '',
  goplusAppSecret: process.env.GOPLUS_APP_SECRET || '',

  agentName: process.env.AGENT_NAME || 'GOAT RiskNet Agent',
  agentDescription:
    process.env.AGENT_DESCRIPTION ||
    'Pay-per-use wallet fraud firewall for AI agents. Pay via x402 on GOAT Network, receive a risk score before funds move.'
}
