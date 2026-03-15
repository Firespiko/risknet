import 'dotenv/config'
import { ethers } from 'ethers'

const BASE = `http://localhost:${process.env.PORT || 3000}`
const FROM_ADDRESS = process.env.AGENT_WALLET_ADDRESS || '0x0000000000000000000000000000000000000000'
const PRIVATE_KEY = process.env.AGENT_PRIVATE_KEY || ''
const RPC_URL = process.env.GOAT_RPC_URL || 'https://rpc.testnet3.goat.network'
const TOKEN_SYMBOL = process.env.GOAT_TOKEN_SYMBOL || 'USDC'
const TOKEN_CONTRACT = process.env.GOAT_USDC_TOKEN_CONTRACT || ''
const TEST_WALLET = process.env.TEST_WALLET || '0x000000000000000000000000000000000000dead'

const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)'
]

async function payOrder({ payToAddress, amountWei, tokenSymbol }) {
  if (!PRIVATE_KEY) throw new Error('AGENT_PRIVATE_KEY missing in .env')
  if (!TOKEN_CONTRACT) throw new Error('GOAT_USDC_TOKEN_CONTRACT / token contract missing in .env')

  const provider = new ethers.JsonRpcProvider(RPC_URL)
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider)
  const token = new ethers.Contract(TOKEN_CONTRACT, ERC20_ABI, wallet)

  const [decimals, balance, symbol] = await Promise.all([
    token.decimals().catch(() => 6),
    token.balanceOf(wallet.address),
    token.symbol().catch(() => tokenSymbol || TOKEN_SYMBOL)
  ])

  console.log('\n3⃣ Paying order automatically with agent wallet...')
  console.log(` Wallet: ${wallet.address}`)
  console.log(` Token: ${symbol} (${TOKEN_CONTRACT})`)
  console.log(` Balance: ${ethers.formatUnits(balance, decimals)} ${symbol}`)
  console.log(` Paying: ${ethers.formatUnits(amountWei, decimals)} ${symbol} → ${payToAddress}`)

  if (balance < BigInt(amountWei)) {
    throw new Error(`Insufficient ${symbol}. Need ${ethers.formatUnits(amountWei, decimals)}, have ${ethers.formatUnits(balance, decimals)}`)
  }

  const tx = await token.transfer(payToAddress, amountWei)
  console.log(` Payment tx sent: ${tx.hash}`)
  const receipt = await tx.wait()
  console.log(` Payment tx confirmed in block ${receipt.blockNumber}`)
  return { txHash: tx.hash, receipt }
}

async function pollUntilPaid(orderId, attempts = 20, delayMs = 3000) {
  console.log('\n4⃣ Waiting for merchant confirmation...')
  for (let i = 0; i < attempts; i++) {
    await new Promise((r) => setTimeout(r, delayMs))
    const status = await fetch(`${BASE}/payment/status/${orderId}`).then((r) => r.json())
    console.log(` Poll ${i + 1}: ${status.status || JSON.stringify(status)}`)
    if (status.status === 'PAYMENT_CONFIRMED' || status.status === 'INVOICED') {
      console.log(' ✅ Merchant confirmed payment!')
      return status
    }
    if (status.status === 'FAILED' || status.status === 'EXPIRED' || status.error) {
      throw new Error(`Payment order failed: ${status.status || status.error}`)
    }
  }
  throw new Error('Timed out waiting for merchant confirmation')
}

async function run() {
  console.log('🐐 GOAT RiskNet Agent — Autonomous x402 Payment Demo')
  console.log('='.repeat(58))
  console.log()

  console.log('1⃣ Fetching agent card...')
  const card = await fetch(`${BASE}/`).then((r) => r.json())
  console.log(` Agent: ${card.agent}`)
  console.log(` Services: ${card.services.map((s) => s.endpoint).join(', ')}`)
  console.log()

  console.log('2⃣ Calling /score without payment...')
  const unpaid = await fetch(`${BASE}/score`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-From-Address': FROM_ADDRESS },
    body: JSON.stringify({ wallet: TEST_WALLET })
  })
  const unpaidData = await unpaid.json()
  console.log(` Status: ${unpaid.status}`)
  console.log(JSON.stringify(unpaidData, null, 2))
  console.log()

  if (unpaid.status !== 402 || !unpaidData.orderId) {
    console.log('No x402 order created. The endpoint may already be bypassed/unlocked or misconfigured.')
    return
  }

  await payOrder({
    payToAddress: unpaidData.payToAddress,
    amountWei: unpaidData.amountWei,
    tokenSymbol: unpaidData.tokenSymbol
  })

  const settled = await pollUntilPaid(unpaidData.orderId)

  console.log('\n5⃣ Retrying /score with X-Order-ID...')
  const paid = await fetch(`${BASE}/score`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Order-ID': unpaidData.orderId
    },
    body: JSON.stringify({ wallet: TEST_WALLET })
  })
  const paidData = await paid.json()
  console.log(` Status: ${paid.status}`)
  console.log(JSON.stringify(paidData, null, 2))

  console.log('\n🐐 Full autonomous x402 flow complete!')
  console.log(` Final merchant status: ${settled.status}`)
}

run().catch((err) => {
  console.error('\n❌ Demo failed:', err.message)
  process.exit(1)
})
