# RiskNet 🐐

RiskNet is a Goat-native wallet risk firewall for AI agents.

It scores EVM wallet addresses before funds are sent, returning a structured risk result that agents or humans can use to allow, review, or block a payment.

## What it does

- Scores a wallet from **0-100**
- Returns a **risk level**: LOW / MEDIUM / HIGH / CRITICAL
- Returns an **action**: ALLOW / REVIEW / BLOCK
- Returns human-readable **reasons** for the score
- Supports **Ethereum** and a Goat-mode EVM flow
- Includes a simple **frontend** and a machine-friendly **API**
- Exposes provider/debug status for **Etherscan** and **GoPlus**
- Returns a **confidence** rating so fallback mode is visible
- Optionally gates requests behind **GoatX402** pay-per-request payment flow

## Why this exists

Autonomous agents should not blindly send funds to arbitrary wallets.
RiskNet adds a preflight check layer:

1. Inspect wallet activity
2. Inspect security flags
3. Compute a fraud-risk heuristic
4. Return a recommendation before payment

## API

### `GET /`
Simple frontend for humans.

### `GET /health`
Health and config status.

### `POST /score`
Request body:

```json
{
  "wallet": "0x...",
  "chain": "ethereum"
}
```

Response shape:

```json
{
  "wallet": "0x...",
  "chain": "ethereum",
  "score": 45,
  "risk": "MEDIUM",
  "action": "REVIEW",
  "confidence": "HIGH",
  "message": "Some risk detected. Proceed with caution.",
  "reasons": [
    "Wallet is 230 days old, which lowers risk.",
    "Wallet has only 45 transactions, so history is still limited."
  ],
  "signals": {
    "age_days": 230,
    "tx_count": 45,
    "sanctioned": false,
    "scam_flags": false,
    "chain_supported": true,
    "used_safe_defaults": false
  },
  "providers": {
    "etherscan": {
      "status": "success",
      "error": null
    },
    "goplus": {
      "status": "success",
      "active_flags": [],
      "response_shape": {
        "topLevelKeys": ["result"],
        "payloadKeys": ["is_sanctioned"]
      },
      "error": null
    }
  },
  "checked_at": "2026-03-15T00:00:00.000Z"
}
```

## Environment variables

```env
GOATX402_MERCHANT_ID=supreme_shop
GOATX402_API_KEY=your_goatx402_api_key
GOATX402_API_SECRET=your_goatx402_api_secret
ETHERSCAN_API_KEY=your_etherscan_api_key
PORT=3000
```

Create a local `.env` file from `.env.example` and fill in the real values. The repository ignores `.env`, so secrets stay local.

## Notes on chains

- `ethereum` uses Etherscan + GoPlus chain id 1.
- `goat` currently uses Goat-oriented labeling plus EVM address validation.
- Since Goat wallets are still EVM-style `0x...` addresses, the format is the same style as Ethereum.
- If you later get a Goat explorer/API, plug it into the chain config and the rest of the app structure is already prepared.

## Run locally

```bash
npm install
node server.js
```

Then open:

<http://localhost:3000>

## Product direction

RiskNet is designed to be both:
- a **human-facing dashboard**, and
- an **agent-facing API**

That makes it useful for demos, hackathons, AI agents, wallets, and automation systems.
