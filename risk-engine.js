import axios from 'axios'
import { config } from './config.js'

const SAFE_DEFAULT_FLAGS = {
  is_sanctioned: '0',
  blackmail_activities: '0',
  stealing_attack: '0',
  honeypot_related_address: '0',
  phishing_activities: '0',
  money_laundering: '0',
  cybercrime: '0',
  mixer: '0',
  financial_crime: '0',
  darkweb_transactions: '0',
  fake_kyc: '0',
  malicious_mining_activities: '0'
}

export function isValidWallet(wallet) {
  return /^0x[a-fA-F0-9]{40}$/.test(wallet || '')
}

function scoreFromWalletAge(ageDays) {
  if (ageDays > 365) return 5
  if (ageDays > 180) return 15
  if (ageDays > 90) return 30
  if (ageDays > 30) return 55
  if (ageDays > 7) return 75
  return 90
}

function scoreFromTxCount(count) {
  if (count > 500) return 5
  if (count > 100) return 15
  if (count > 50) return 25
  if (count > 20) return 40
  if (count > 5) return 60
  return 85
}

function getRiskLevel(score) {
  if (score <= 30) return 'LOW'
  if (score <= 60) return 'MEDIUM'
  if (score <= 80) return 'HIGH'
  return 'CRITICAL'
}

function getAction(score) {
  if (score <= 30) return 'ALLOW'
  if (score <= 60) return 'REVIEW'
  return 'BLOCK'
}

function getRiskMessage(risk) {
  switch (risk) {
    case 'LOW':
      return 'Clean wallet. Safe to transact.'
    case 'MEDIUM':
      return 'Some risk detected. Proceed with caution.'
    case 'HIGH':
      return 'High risk wallet. Verify before sending funds.'
    default:
      return 'DANGER: Do not transact with this wallet.'
  }
}

function extractGoPlusAddressPayload(responseData, wallet) {
  const loweredWallet = String(wallet || '').toLowerCase()
  const candidates = [responseData?.result, responseData?.data]

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    if (candidate[wallet]) return candidate[wallet]
    if (candidate[loweredWallet]) return candidate[loweredWallet]
    const keys = Object.keys(candidate)
    if (keys.length === 1 && typeof candidate[keys[0]] === 'object') return candidate[keys[0]]
    if ('is_sanctioned' in candidate || 'sanctioned' in candidate || 'stealing_attack' in candidate) return candidate
  }

  return {}
}

async function fetchEtherscanSignals(wallet) {
  if (!config.etherscanApiKey || config.etherscanApiKey.includes('<paste')) {
    return { ageDays: 0, txCount: 0, usedSafeDefaults: true, status: 'fallback', error: 'missing_key' }
  }

  try {
    const response = await axios.get('https://api.etherscan.io/api', {
      params: {
        module: 'account',
        action: 'txlist',
        address: wallet,
        startblock: 0,
        endblock: 99999999,
        sort: 'asc',
        apikey: config.etherscanApiKey
      },
      timeout: 15000
    })

    const result = Array.isArray(response.data?.result) ? response.data.result : []
    if (!result.length) return { ageDays: 0, txCount: 0, usedSafeDefaults: true, status: 'empty', error: null }

    const firstTimestamp = Number(result[0]?.timeStamp || 0)
    const ageDays = firstTimestamp ? Math.max(0, Math.floor((Date.now() - firstTimestamp * 1000) / 86400000)) : 0
    return { ageDays, txCount: result.length, usedSafeDefaults: false, status: 'success', error: null }
  } catch (error) {
    return { ageDays: 0, txCount: 0, usedSafeDefaults: true, status: 'fallback', error: error.message }
  }
}

async function fetchGoPlusSignals(wallet) {
  try {
    const headers = {}
    if (config.goplusAppKey) headers['X-API-KEY'] = config.goplusAppKey
    if (config.goplusAppSecret) headers['X-API-SECRET'] = config.goplusAppSecret

    const response = await axios.get(`${config.goplusApiBase}/address_security/${wallet}`, {
      params: { chain_id: 1 },
      headers,
      timeout: 15000
    })

    const payload = extractGoPlusAddressPayload(response.data, wallet)
    const flags = {
      is_sanctioned: payload.is_sanctioned ?? payload.sanctioned ?? SAFE_DEFAULT_FLAGS.is_sanctioned,
      blackmail_activities: payload.blackmail_activities ?? SAFE_DEFAULT_FLAGS.blackmail_activities,
      stealing_attack: payload.stealing_attack ?? SAFE_DEFAULT_FLAGS.stealing_attack,
      honeypot_related_address: payload.honeypot_related_address ?? SAFE_DEFAULT_FLAGS.honeypot_related_address,
      phishing_activities: payload.phishing_activities ?? SAFE_DEFAULT_FLAGS.phishing_activities,
      money_laundering: payload.money_laundering ?? SAFE_DEFAULT_FLAGS.money_laundering,
      cybercrime: payload.cybercrime ?? SAFE_DEFAULT_FLAGS.cybercrime,
      mixer: payload.mixer ?? SAFE_DEFAULT_FLAGS.mixer,
      financial_crime: payload.financial_crime ?? SAFE_DEFAULT_FLAGS.financial_crime,
      darkweb_transactions: payload.darkweb_transactions ?? SAFE_DEFAULT_FLAGS.darkweb_transactions,
      fake_kyc: payload.fake_kyc ?? SAFE_DEFAULT_FLAGS.fake_kyc,
      malicious_mining_activities: payload.malicious_mining_activities ?? SAFE_DEFAULT_FLAGS.malicious_mining_activities
    }

    const activeFlags = Object.entries(flags).filter(([, value]) => String(value) === '1').map(([key]) => key)
    return {
      flags,
      usedSafeDefaults: false,
      status: 'success',
      activeFlags,
      responseShape: { topLevelKeys: Object.keys(response.data || {}), payloadKeys: Object.keys(payload || {}) },
      error: null
    }
  } catch (error) {
    return {
      flags: { ...SAFE_DEFAULT_FLAGS },
      usedSafeDefaults: true,
      status: 'fallback',
      activeFlags: [],
      responseShape: { topLevelKeys: [], payloadKeys: [] },
      error: error.message
    }
  }
}

function buildReasons({ ageDays, txCount, activeFlags, usedSafeDefaults }) {
  const reasons = []
  if (ageDays > 365) reasons.push(`Wallet is ${ageDays} days old, which lowers risk.`)
  else if (ageDays > 90) reasons.push(`Wallet is ${ageDays} days old, giving it moderate history.`)
  else if (ageDays > 7) reasons.push(`Wallet is only ${ageDays} days old, which raises risk.`)
  else reasons.push(`Wallet is extremely new (${ageDays} days old), which is a strong risk signal.`)

  if (txCount > 500) reasons.push(`Wallet has a deep transaction history (${txCount} tx), which lowers risk.`)
  else if (txCount > 50) reasons.push(`Wallet has a reasonable transaction history (${txCount} tx).`)
  else if (txCount > 5) reasons.push(`Wallet has limited history (${txCount} tx), so confidence is lower.`)
  else reasons.push(`Wallet has almost no transaction history (${txCount} tx), which is suspicious.`)

  if (activeFlags.length) reasons.push(`GoPlus flagged the wallet for: ${activeFlags.join(', ')}.`)
  if (usedSafeDefaults) reasons.push('Some external data sources were unavailable, so safe defaults were used for part of the analysis.')
  return reasons
}

function getConfidence(explorerStatus, goplusStatus, usedSafeDefaults) {
  if (!usedSafeDefaults && explorerStatus === 'success' && goplusStatus === 'success') return 'HIGH'
  if (explorerStatus === 'success' || goplusStatus === 'success') return 'MEDIUM'
  return 'LOW'
}

export async function scoreWallet(wallet) {
  const [explorerData, goPlusData] = await Promise.all([fetchEtherscanSignals(wallet), fetchGoPlusSignals(wallet)])
  const dataUsedSafeDefaults = explorerData.usedSafeDefaults || goPlusData.usedSafeDefaults

  const walletAgeScore = scoreFromWalletAge(explorerData.ageDays)
  const txCountScore = scoreFromTxCount(explorerData.txCount)
  const sanctionsScore = String(goPlusData.flags.is_sanctioned) === '1' ? 100 : 0
  const weightedFlagScores = {
    stealing_attack: 95,
    blackmail_activities: 85,
    honeypot_related_address: 85,
    phishing_activities: 80,
    money_laundering: 95,
    cybercrime: 90,
    mixer: 70,
    financial_crime: 95,
    darkweb_transactions: 90,
    fake_kyc: 60,
    malicious_mining_activities: 55
  }
  const scamScore = goPlusData.activeFlags.reduce((max, key) => Math.max(max, weightedFlagScores[key] || 0), 0)

  const score = Math.round(walletAgeScore * 0.25 + txCountScore * 0.2 + sanctionsScore * 0.35 + scamScore * 0.2)
  const risk = getRiskLevel(score)
  const action = getAction(score)
  const confidence = getConfidence(explorerData.status, goPlusData.status, dataUsedSafeDefaults)

  return {
    wallet,
    chain: 'goat-testnet',
    score,
    risk,
    action,
    confidence,
    message: getRiskMessage(risk),
    reasons: buildReasons({ ageDays: explorerData.ageDays, txCount: explorerData.txCount, activeFlags: goPlusData.activeFlags, usedSafeDefaults: dataUsedSafeDefaults }),
    signals: {
      age_days: explorerData.ageDays,
      tx_count: explorerData.txCount,
      sanctioned: String(goPlusData.flags.is_sanctioned) === '1',
      scam_flags: goPlusData.activeFlags.length > 0,
      active_flags: goPlusData.activeFlags,
      used_safe_defaults: dataUsedSafeDefaults
    },
    providers: {
      etherscan: { status: explorerData.status, error: explorerData.error },
      goplus: { status: goPlusData.status, active_flags: goPlusData.activeFlags, response_shape: goPlusData.responseShape, error: goPlusData.error }
    },
    checked_at: new Date().toISOString()
  }
}
