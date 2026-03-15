# RiskNet 🐐

RiskNet is now a **GOAT-native paid agent**:
- **ERC-8004** on-chain agent identity
- **x402** pay-per-request payment flow
- **GOAT Testnet3** network config
- paid `POST /score` wallet-risk endpoint for agents

## What it does

A client or agent can:
1. Call `POST /score` without payment
2. Receive an x402 `402 Payment Required` response with order details
3. Pay on GOAT Testnet3
4. Retry with `X-Order-ID`
5. Receive wallet risk score + action + reasons

## Files

- `server.js` — main GOAT RiskNet agent API
- `config.js` — env/config loader
- `x402.js` — x402 middleware + order verification
- `agent-identity.js` — ERC-8004 identity loading/registration
- `register-agent.js` — one-time on-chain registration script
- `risk-engine.js` — wallet scoring logic (Etherscan + GoPlus)
- `test-payment.js` — demo client for the x402 flow

## Environment

Create `.env`:

```env
GOATX402_API_URL=https://x402-api-lx58aabp0r.testnet3.goat.network
GOATX402_MERCHANT_ID=supreme_shop
GOATX402_API_KEY=your_goatx402_api_key
GOATX402_API_SECRET=your_goatx402_api_secret

GOAT_RPC_URL=https://rpc.testnet3.goat.network
GOAT_USDC_TOKEN_CONTRACT=0x29d1ee93e9ecf6e50f309f498e40a6b42d352fa1
GOAT_IDENTITY_REGISTRY=0x8004A169FB4a3325136EB29fA0ceB6D2e539a432

AGENT_PRIVATE_KEY=your_testnet_private_key
AGENT_WALLET_ADDRESS=your_wallet_address
AGENT_ID=

ETHERSCAN_API_KEY=your_etherscan_api_key
PORT=3000
PRICE_PER_RISK_SCORE=20000
```

## Install

```bash
npm install
```

## Run agent

```bash
npm start
```

## Register ERC-8004 identity

Fund the wallet first using the GOAT faucet, then:

```bash
npm run register-agent
```

After registration, add the printed `AGENT_ID` into `.env`.

## Test x402 flow

```bash
npm run test-payment
```

## Key endpoints

- `GET /` — polished dashboard (HTML) or agent card JSON with `?format=json`
- `GET /health` — health/config status
- `GET /activity` — recent orders / payments / reports feed
- `GET /identity` — ERC-8004 identity state
- `GET /payment/status/:orderId` — x402 order status
- `POST /analyze` — free comprehensive risk/decision report for a wallet
- `POST /score` — paid x402-gated wallet scoring endpoint

## Notes

- GOAT testnet wallets still look like normal EVM `0x...` addresses.
- GoPlus is used as a public security-signal source in this app.
- Etherscan is used for wallet age / transaction history heuristics.
- The current scoring engine is still heuristic/MVP, but now the full GOAT agent/payment story is in place.
