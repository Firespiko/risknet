import { GoatX402Client } from 'goatx402-sdk-server'
import { ethers } from 'ethers'
import { config } from './config.js'
import { recordOrder, recordPayment } from './activity-store.js'

export const client = new GoatX402Client({
  baseUrl: config.apiUrl,
  apiKey: config.apiKey,
  apiSecret: config.apiSecret
})

const paidOrders = new Map()
const createdOrders = new Map()
const provider = new ethers.JsonRpcProvider(config.rpcUrl)
const ERC20_TRANSFER_ABI = ['event Transfer(address indexed from, address indexed to, uint256 value)']

async function findOnchainPayment(orderId) {
  const meta = createdOrders.get(orderId)
  if (!meta?.tokenContract || !meta?.fromAddress || !meta?.payToAddress) return null

  try {
    const contract = new ethers.Contract(meta.tokenContract, ERC20_TRANSFER_ABI, provider)
    const latestBlock = await provider.getBlockNumber()
    const fromBlock = Math.max(0, meta.createdBlock - 5)
    const logs = await contract.queryFilter(
      contract.filters.Transfer(meta.fromAddress, meta.payToAddress),
      fromBlock,
      latestBlock
    )

    const match = logs.find((log) => {
      const value = log.args?.value
      return value != null && BigInt(value.toString()) === BigInt(meta.amountWei)
    })

    if (!match) return null

    const receipt = await match.getTransactionReceipt()
    return {
      orderId,
      paidAt: new Date().toISOString(),
      fromAddress: meta.fromAddress,
      amountWei: meta.amountWei,
      txHash: receipt.hash,
      status: 'ONCHAIN_CONFIRMED_FALLBACK',
      blockNumber: receipt.blockNumber
    }
  } catch (err) {
    console.error('[x402] On-chain fallback check failed:', err.message)
    return null
  }
}

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

        const createdBlock = await provider.getBlockNumber()
        createdOrders.set(order.orderId, {
          createdAt: Date.now(),
          createdBlock,
          fromAddress,
          payToAddress: order.payToAddress,
          amountWei,
          tokenSymbol: config.tokenSymbol,
          tokenContract: config.tokenContract,
          chainId: config.chainId
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

      const fallbackPayment = status.status === 'CHECKOUT_VERIFIED' ? await findOnchainPayment(orderId) : null
      if (fallbackPayment) {
        paidOrders.set(orderId, fallbackPayment)
        req.payment = fallbackPayment
        recordPayment(fallbackPayment)
        console.log(`[x402] ✅ On-chain fallback matched payment: ${orderId} (${fallbackPayment.txHash})`)
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
