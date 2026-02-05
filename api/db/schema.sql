CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  wallet_address TEXT UNIQUE NOT NULL,
  credit_balance INTEGER NOT NULL DEFAULT 0,
  raffle_tickets_total INTEGER NOT NULL DEFAULT 0,
  equipped_note_skin_id INTEGER NOT NULL,
  equipped_gear_skin_id INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS credit_ledger (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS onchain_deposits (
  id SERIAL PRIMARY KEY,
  chain_id INTEGER NOT NULL,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  amount_wei NUMERIC NOT NULL,
  credits_minted INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (chain_id, tx_hash, log_index)
);

CREATE TABLE IF NOT EXISTS runs (
  run_id UUID PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  raw_score INTEGER,
  multiplier_locked INTEGER NOT NULL,
  cleared BOOLEAN,
  tickets_earned INTEGER,
  status TEXT NOT NULL DEFAULT 'started',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS leaderboards_cache (
  id SERIAL PRIMARY KEY,
  leaderboard_type TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  value INTEGER NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS nft_collections (
  id SERIAL PRIMARY KEY,
  chain_id INTEGER NOT NULL,
  contract_address TEXT NOT NULL,
  UNIQUE(chain_id, contract_address)
);

CREATE TABLE IF NOT EXISTS skin_catalog (
  skin_id INTEGER PRIMARY KEY,
  skin_type TEXT NOT NULL,
  display_name TEXT NOT NULL,
  asset_ref TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nft_skin_rules (
  id SERIAL PRIMARY KEY,
  contract_address TEXT NOT NULL,
  token_id TEXT NOT NULL,
  skin_id INTEGER NOT NULL REFERENCES skin_catalog(skin_id),
  UNIQUE(contract_address, token_id)
);

CREATE TABLE IF NOT EXISTS user_unlocked_skins (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  skin_id INTEGER NOT NULL REFERENCES skin_catalog(skin_id),
  unlocked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, skin_id)
);
