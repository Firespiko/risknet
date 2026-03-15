import 'dotenv/config'

const BASE = `http://localhost:${process.env.PORT || 3000}`
const FROM_ADDRESS = process.env.AGENT_WALLET_ADDRESS || '0x0000000000000000000000000000000000000000'
const TEST_WALLET = process.env.TEST_WALLET || '0x000000000000000000000000000000000000dead'

async function run() {
  console.log('🐐 GOAT RiskNet Agent — x402 Payment Flow Demo')
  console.log('='.repeat(56))
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

  if (!unpaidData.orderId) {
    console.log('No x402 order created. That usually means x402 is bypassed or not fully configured.')
    return
  }

  const orderId = unpaidData.orderId
  console.log('3⃣ Polling payment status...')
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 3000))
    const status = await fetch(`${BASE}/payment/status/${orderId}`).then((r) => r.json())
    console.log(` Poll ${i + 1}: ${status.status || JSON.stringify(status)}`)
    if (status.status === 'PAYMENT_CONFIRMED' || status.status === 'INVOICED') {
      console.log('✅ Payment confirmed!')
      break
    }
  }

  console.log('\n4⃣ Retrying /score with X-Order-ID...')
  const paid = await fetch(`${BASE}/score`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Order-ID': orderId },
    body: JSON.stringify({ wallet: TEST_WALLET })
  })
  const paidData = await paid.json()
  console.log(` Status: ${paid.status}`)
  console.log(JSON.stringify(paidData, null, 2))
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
