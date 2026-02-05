# Enoch Musics MVP

Production-minded MVP for the Web3 rhythm game. Unity WebGL client is managed separately; this repo ships the web frontend, backend API, indexer worker, and the on-chain deposit contract.

## Monorepo Layout

- `web/` - Web frontend (wallet connect, credits purchase, leaderboards, skins, chat UI)
- `api/` - REST API (runs, credits, skins, leaderboards)
- `worker/` - Deposit indexer (mints off-chain credits)
- `contracts/` - Solidity deposit contract + deploy script

## Prerequisites

- Node.js 18+
- Postgres 14+
- Redis 6+
- An Abstract Testnet RPC endpoint

## Quick Start

```bash
# 1) Install dependencies
npm install --workspace=api --workspace=web --workspace=worker --workspace=contracts

# 2) Configure env
cp api/.env.example api/.env
cp worker/.env.example worker/.env
cp web/.env.example web/.env
cp contracts/.env.example contracts/.env

# 3) Create DB schema
psql "$DATABASE_URL" -f api/db/schema.sql

# 4) Run API + worker + web
npm run dev --workspace=api
npm run dev --workspace=worker
npm run dev --workspace=web
```

## Environment Configuration

### API (`api/.env`)

```
PORT=4000
DATABASE_URL=postgres://postgres:postgres@localhost:5432/enochmusics
DATABASE_CA_PATH=/path/to/db/ca.pem
DATABASE_CERT_PATH=/path/to/db/client-cert.pem
DATABASE_KEY_PATH=/path/to/db/client-key.pem
REDIS_URL=rediss://redis.example:6380
REDIS_PASSWORD=change_me
REDIS_CA_PATH=/path/to/redis/ca.pem
REDIS_CERT_PATH=/path/to/redis/client-cert.pem
REDIS_KEY_PATH=/path/to/redis/client-key.pem
TLS_CERT_PATH=/path/to/api/tls-cert.pem
TLS_KEY_PATH=/path/to/api/tls-key.pem
TLS_CA_PATH=/path/to/api/ca.pem
ENCRYPTION_KEYS=primary:BASE64_32BYTE_KEY,rotated:BASE64_32BYTE_KEY
ALLOW_INSECURE_LOCAL=false
ADMIN_API_KEY=change_me
JWT_SECRET=dev_secret
CHAIN_ID=11124
RPC_URL=https://abstract-testnet-rpc.example
CONFIRMATIONS_REQUIRED=3
DEPOSIT_CONTRACT_ADDRESS=0x0000000000000000000000000000000000000000
DEFAULT_NOTE_SKIN_ID=1
DEFAULT_GEAR_SKIN_ID=100
CREDIT_PRICE_WEI=1000000000000000
```

### Worker (`worker/.env`)

```
DATABASE_URL=postgres://postgres:postgres@localhost:5432/enochmusics
DATABASE_CA_PATH=/path/to/db/ca.pem
DATABASE_CERT_PATH=/path/to/db/client-cert.pem
DATABASE_KEY_PATH=/path/to/db/client-key.pem
ENCRYPTION_KEYS=primary:BASE64_32BYTE_KEY,rotated:BASE64_32BYTE_KEY
ALLOW_INSECURE_LOCAL=false
CHAIN_ID=11124
RPC_URL=https://abstract-testnet-rpc.example
CONFIRMATIONS_REQUIRED=3
DEPOSIT_CONTRACT_ADDRESS=0x0000000000000000000000000000000000000000
CREDIT_PRICE_WEI=1000000000000000
```

### Web (`web/.env`)

```
VITE_API_URL=https://localhost:4000
VITE_CHAIN_ID=11124
VITE_DEPOSIT_CONTRACT=0x0000000000000000000000000000000000000000
VITE_CREDIT_PRICE_WEI=1000000000000000
VITE_UNITY_URL=https://example.com/unity/index.html
VITE_CHAT_WS_URL=wss://localhost:4000
VITE_ALLOW_INSECURE_LOCAL=true
```

### Contracts (`contracts/.env`)

```
PRIVATE_KEY=0xabc123...
RPC_URL=https://abstract-testnet-rpc.example
```

## Testnet Usage Guide

1. Deploy `Deposit` contract:
   ```bash
   npm run compile --workspace=contracts
   npm run deploy --workspace=contracts
   ```
2. Update API + Worker env values with the deployed address.
3. Start the worker to index `Deposit` events and mint credits off-chain.

## Notes

- Credit price is fixed: **0.001 ETH = 1 Credit** (configurable via `CREDIT_PRICE_WEI`).
- Credits are stored off-chain; the chain is only used for deposits.
- Backend is authoritative for runs, tickets, and skin equip.

## Security Architecture & Encryption Model

- **In-transit encryption:** API traffic must be HTTPS (TLS 1.2+), WebSocket traffic must be WSS, and backend services require TLS for Postgres and Redis. The API refuses to start without TLS certs unless `ALLOW_INSECURE_LOCAL=true` for localhost-only development. Clients validate TLS and do not downgrade to plaintext. 
- **At-rest encryption:** Wallet addresses, credit balances, raffle ticket totals, and on-chain transaction references are encrypted using AES-256-GCM before being persisted. Encrypted values are stored alongside deterministic hashes (SHA-256) for lookup-only scenarios.
- **Key management & rotation:** Encryption keys are provided via `ENCRYPTION_KEYS` (comma-separated `keyId:base64` values). The first key is used for new writes; older keys remain available for decryption to allow rotation without data loss. Keys are never hardcoded. 
- **Auditability:** Services log when TLS connections are established for API, Postgres, and Redis, and log encryption/decryption failures without exposing sensitive payloads. 
