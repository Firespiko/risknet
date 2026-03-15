import { GoatX402Client } from 'goatx402-sdk-server'
import { config } from './config.js'
import { recordOrder, recordPayment } from './activity-store.js'

export const client = new GoatX402Client({
  baseUrl: config.apiUrl,
  apiKey: config.apiKey,
  apiSecret: config.apiSecret
})

const paidOrders = new Map()

export function requirePayment(amountWei) {
  return async (req, res, next) => {
    if (!config.apiKey || !config.apiSecret || !config.merchantId) {
      req.payment = { bypassed: true, reason: 'x402_not_configured' }
      return next()
    }

    const orderId = req.headers['x-order-id']

    if (!orderId) {
      const fromAddress = req.headers['x-from-address'] || req.body?.payer || config.agentWalletAddress || '0x0000000000000000000000000000000000000000'

      try {
        const order = await client.createOrder({
          dappOrderId: `risknet-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          chainId: config.chainId,
          tokenSymbol: config.tokenSymbol,
          tokenContract: config.tokenContract,
          fromAddress,
          amountWei
        })

        recordOrder({
          orderId: order.orderId,
          flow: order.flow,
          payToAddress: order.payToAddress,
          fromAddress,
          amountWei,
          tokenSymbol: config.tokenSymbol,
          chainId: config.chainId,
          status: 'PAYMENT_REQUIRED'
        })

        return res.status(402).json({
          error: 'Payment required',
          orderId: order.orderId,
          flow: order.flow,
          payToAddress: order.payToAddress,
          amountWei,
          tokenSymbol: config.tokenSymbol,
          chainId: config.chainId,
          expiresAt: order.expiresAt,
          instructions: `Pay ${Number(amountWei) / 1e6} ${config.tokenSymbol} on GOAT testnet, then retry with header: X-Order-ID: ${order.orderId}`
        })
      } catch (err) {
        console.error('[x402] Order creation failed:', err.message)
        return res.status(500).json({ error: 'Failed to create payment order', details: err.message })
      }
    }

    if (paidOrders.has(orderId)) {
      req.payment = paidOrders.get(orderId)
      return next()
    }

    try {
      const status = await client.getOrderStatus(orderId)

      if (status.status === 'PAYMENT_CONFIRMED' || status.status === 'INVOICED') {
        const paymentInfo = {
          orderId,
          paidAt: status.confirmedAt,
          fromAddress: status.fromAddress,
          amountWei: status.amountWei,
          txHash: status.txHash,
          status: status.status
        }
        paidOrders.set(orderId, paymentInfo)
        req.payment = paymentInfo
        recordPayment(paymentInfo)
        console.log(`[x402] ✅ Payment verified: ${orderId}`)
        return next()
      }

      recordPayment({
        orderId,
        status: status.status,
        fromAddress: status.fromAddress,
        amountWei: status.amountWei,
        txHash: status.txHash || null
      })

      return res.status(402).json({
        error: 'Payment not confirmed',
        orderId,
        status: status.status,
        message: `Order status is ${status.status}. Pay first, then retry.`
      })
    } catch (err) {
      console.error('[x402] Status check failed:', err.message)
      return res.status(402).json({ error: 'Could not verify payment', details: err.message })
    }
  }
}
