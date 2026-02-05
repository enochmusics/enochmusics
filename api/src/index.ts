import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { ethers } from 'ethers';
import { pool, query } from './db.js';
import { createServer as createHttpServer } from 'http';
import { createServer as createHttpsServer } from 'https';
import { WebSocketServer } from 'ws';
import Redis from 'ioredis';
import { decryptString, encryptString, hashValue } from './security/encryption.js';
import { allowInsecureLocal, enforceTlsUrl, requireEnv } from './security/secrets.js';
import { loadClientTlsConfig, loadServerTlsConfig } from './security/tls.js';

const app = express();
app.use(cors());
app.use(express.json());

const port = Number(process.env.PORT || 4000);
const baseTicketsPerClear = 1;
const defaultNoteSkinId = Number(process.env.DEFAULT_NOTE_SKIN_ID || 1);
const defaultGearSkinId = Number(process.env.DEFAULT_GEAR_SKIN_ID || 100);
const maxRawScore = Number(process.env.MAX_RAW_SCORE || 10000000);
const minRunDurationSeconds = Number(process.env.MIN_RUN_DURATION_SECONDS || 10);
const maxRunDurationSeconds = Number(process.env.MAX_RUN_DURATION_SECONDS || 3600);
const runTimeoutSeconds = Number(process.env.RUN_TIMEOUT_SECONDS || 900);
const runAbortRefundRatio = Number(process.env.RUN_ABORT_REFUND_RATIO || 1);
const rateLimitWindowMs = Number(process.env.RATE_LIMIT_WINDOW_MS || 60000);
const rateLimitMax = Number(process.env.RATE_LIMIT_MAX || 30);
const creditPriceWei = BigInt(requireEnv('CREDIT_PRICE_WEI'));
const rpcUrl = requireEnv('RPC_URL');
enforceTlsUrl(rpcUrl, 'RPC_URL');
const depositContractAddress = requireEnv('DEPOSIT_CONTRACT_ADDRESS');
const serverWalletAddress = normalizeWalletAddress(requireEnv('SERVER_WALLET_ADDRESS'));
const serverWalletPrivateKey = requireEnv('SERVER_WALLET_PRIVATE_KEY');
const serverProvider = new ethers.JsonRpcProvider(rpcUrl);
const serverSigner = new ethers.Wallet(serverWalletPrivateKey, serverProvider);
if (normalizeWalletAddress(serverSigner.address) !== serverWalletAddress) {
  throw new Error('SERVER_WALLET_ADDRESS does not match SERVER_WALLET_PRIVATE_KEY');
}
const depositAbi = ['function deposit(bytes32 orderId) payable'];
const erc721Abi = ['function ownerOf(uint256 tokenId) view returns (address)'];
const depositContract = new ethers.Contract(depositContractAddress, depositAbi, serverSigner);

function normalizeWalletAddress(value: string) {
  return value.toLowerCase();
}

function getWalletAddress(req: express.Request) {
  const headerWallet = req.header('x-wallet-address');
  return headerWallet ? normalizeWalletAddress(headerWallet) : null;
}

function getWalletHash(wallet: string) {
  return hashValue(wallet);
}

function buildRunChecksum(runId: string, rawScore: number, runNonce: string) {
  return hashValue(`${runId}:${rawScore}:${runNonce}`);
}

function rateLimit(scope: string) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const key = `${scope}:${req.ip}`;
    const now = Date.now();
    const existing = hits.get(key);
    if (!existing || existing.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + rateLimitWindowMs });
      return next();
    }
    if (existing.count >= rateLimitMax) {
      res.setHeader('Retry-After', Math.ceil((existing.resetAt - now) / 1000));
      return res.status(429).json({ error: 'rate limit exceeded' });
    }
    existing.count += 1;
    return next();
  };
}

async function ensureDefaultSkins() {
  await query(
    `INSERT INTO skin_catalog (skin_id, skin_type, display_name, asset_ref)
     VALUES ($1, 'note', 'Default Note', 'note/default'),
            ($2, 'gear', 'Default Gear', 'gear/default')
     ON CONFLICT (skin_id) DO NOTHING`,
    [defaultNoteSkinId, defaultGearSkinId]
  );
}

async function ensureUserDefaults(userId: number) {
  await query(
    `INSERT INTO user_unlocked_skins (user_id, skin_id)
     VALUES ($1, $2), ($1, $3)
     ON CONFLICT DO NOTHING`,
    [userId, defaultNoteSkinId, defaultGearSkinId]
  );
}

async function refreshNftSkinsForUser(userId: number, walletAddress: string) {
  const rules = await query<{ contract_address: string; token_id: string; skin_id: number }>(
    `SELECT contract_address, token_id, skin_id FROM nft_skin_rules`
  );
  if (rules.rowCount === 0) {
    return;
  }
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const ownedSkinIds = new Set<number>();
  for (const rule of rules.rows) {
    try {
      const contract = new ethers.Contract(rule.contract_address, erc721Abi, provider);
      const owner = await contract.ownerOf(rule.token_id);
      if (normalizeWalletAddress(owner) === normalizeWalletAddress(walletAddress)) {
        ownedSkinIds.add(rule.skin_id);
      }
    } catch (error) {
      console.warn('NFT ownership check failed', { contract: rule.contract_address, tokenId: rule.token_id });
    }
  }

  const allRuleSkinIds = rules.rows.map((rule) => rule.skin_id);
  const skinsToRemove = allRuleSkinIds.filter((skinId) => !ownedSkinIds.has(skinId));
  const skinsToAdd = Array.from(ownedSkinIds);

  if (skinsToRemove.length > 0) {
    await query(
      `DELETE FROM user_unlocked_skins
       WHERE user_id = $1 AND skin_id = ANY($2::int[])`,
      [userId, skinsToRemove]
    );
  }
  if (skinsToAdd.length > 0) {
    await query(
      `INSERT INTO user_unlocked_skins (user_id, skin_id)
       SELECT $1, unnest($2::int[])
       ON CONFLICT DO NOTHING`,
      [userId, skinsToAdd]
    );
  }

  const equippedResult = await query(
    'SELECT equipped_note_skin_id, equipped_gear_skin_id FROM users WHERE id = $1',
    [userId]
  );
  if (equippedResult.rowCount > 0) {
    const equippedNote = equippedResult.rows[0].equipped_note_skin_id;
    const equippedGear = equippedResult.rows[0].equipped_gear_skin_id;
    if (skinsToRemove.includes(equippedNote)) {
      await query('UPDATE users SET equipped_note_skin_id = $1 WHERE id = $2', [defaultNoteSkinId, userId]);
    }
    if (skinsToRemove.includes(equippedGear)) {
      await query('UPDATE users SET equipped_gear_skin_id = $1 WHERE id = $2', [defaultGearSkinId, userId]);
    }
  }
}

function decryptNumber(value: string, label: string) {
  const parsed = Number(decryptString(value));
  if (Number.isNaN(parsed)) {
    throw new Error(`${label} decrypt failed`);
  }
  return parsed;
}

function mapUserRow(row: {
  id: number;
  wallet_address_encrypted: string;
  credit_balance_encrypted: string;
  raffle_tickets_total_encrypted: string;
  equipped_note_skin_id: number;
  equipped_gear_skin_id: number;
}) {
  return {
    id: row.id,
    wallet_address: decryptString(row.wallet_address_encrypted),
    credit_balance: decryptNumber(row.credit_balance_encrypted, 'credit_balance'),
    raffle_tickets_total: decryptNumber(row.raffle_tickets_total_encrypted, 'raffle_tickets_total'),
    equipped_note_skin_id: row.equipped_note_skin_id,
    equipped_gear_skin_id: row.equipped_gear_skin_id,
  };
}

async function ensureUserForWallet(walletAddress: string) {
  await ensureDefaultSkins();
  const walletHash = getWalletHash(walletAddress);
  const walletEncrypted = encryptString(walletAddress);
  const creditBalanceEncrypted = encryptString('0');
  const raffleTicketsEncrypted = encryptString('0');

  const upsert = await query<{ id: number }>(
    `INSERT INTO users (
        wallet_address_encrypted,
        wallet_address_hash,
        credit_balance_encrypted,
        raffle_tickets_total_encrypted,
        equipped_note_skin_id,
        equipped_gear_skin_id
     )
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (wallet_address_hash)
     DO UPDATE SET wallet_address_encrypted = EXCLUDED.wallet_address_encrypted
     RETURNING id`,
    [
      walletEncrypted,
      walletHash,
      creditBalanceEncrypted,
      raffleTicketsEncrypted,
      defaultNoteSkinId,
      defaultGearSkinId,
    ]
  );

  const userId = upsert.rows[0].id;
  await ensureUserDefaults(userId);
  await refreshNftSkinsForUser(userId, walletAddress);

  const user = await query(
    `SELECT id, wallet_address_encrypted, credit_balance_encrypted, raffle_tickets_total_encrypted,
            equipped_note_skin_id, equipped_gear_skin_id
     FROM users WHERE id = $1`,
    [userId]
  );

  return mapUserRow(user.rows[0]);
}

app.post('/auth/wallet-login', rateLimit('auth'), async (req, res) => {
  const walletAddress = (req.body.walletAddress as string | undefined)
    ? normalizeWalletAddress(req.body.walletAddress)
    : undefined;
  if (!walletAddress) {
    return res.status(400).json({ error: 'walletAddress required' });
  }

  const user = await ensureUserForWallet(walletAddress);
  return res.json({ user });
});

app.post('/auth/server-login', rateLimit('auth'), async (_req, res) => {
  const user = await ensureUserForWallet(serverWalletAddress);
  return res.json({ user });
});

app.get('/me', async (req, res) => {
  const wallet = getWalletAddress(req);
  if (!wallet) {
    return res.status(401).json({ error: 'x-wallet-address required' });
  }
  const walletHash = getWalletHash(wallet);
  const result = await query(
    `SELECT id, wallet_address_encrypted, credit_balance_encrypted, raffle_tickets_total_encrypted,
            equipped_note_skin_id, equipped_gear_skin_id
     FROM users WHERE wallet_address_hash = $1`,
    [walletHash]
  );
  if (result.rowCount === 0) {
    return res.status(404).json({ error: 'user not found' });
  }
  return res.json({ user: mapUserRow(result.rows[0]) });
});

app.post('/credits/create-order', rateLimit('credits'), async (req, res) => {
  const wallet = getWalletAddress(req);
  if (!wallet) {
    return res.status(401).json({ error: 'x-wallet-address required' });
  }
  const walletHash = getWalletHash(wallet);
  const userResult = await query('SELECT id FROM users WHERE wallet_address_hash = $1', [walletHash]);
  if (userResult.rowCount === 0) {
    return res.status(404).json({ error: 'user not found' });
  }

  const orderId = uuidv4();
  const orderIdBytes32 = ethers.id(orderId);
  const orderIdHash = hashValue(orderIdBytes32);

  await query(
    `INSERT INTO credit_orders (user_id, order_id_encrypted, order_id_hash)
     VALUES ($1, $2, $3)
     ON CONFLICT (order_id_hash) DO NOTHING`,
    [userResult.rows[0].id, encryptString(orderIdBytes32), orderIdHash]
  );

  return res.json({ orderId, orderIdBytes32 });
});

app.post('/credits/buy', rateLimit('credits'), async (req, res) => {
  const wallet = getWalletAddress(req);
  if (!wallet) {
    return res.status(401).json({ error: 'x-wallet-address required' });
  }
  if (wallet !== serverWalletAddress) {
    return res.status(403).json({ error: 'wallet not authorized for server purchases' });
  }
  const orderId = req.body.orderId as string | undefined;
  if (!orderId) {
    return res.status(400).json({ error: 'orderId required' });
  }
  const orderIdBytes32 = ethers.id(orderId);
  const orderIdHash = hashValue(orderIdBytes32);
  const orderResult = await query(
    'SELECT id FROM credit_orders WHERE order_id_hash = $1',
    [orderIdHash]
  );
  if (orderResult.rowCount === 0) {
    return res.status(404).json({ error: 'order not found' });
  }

  const tx = await depositContract.deposit(orderIdBytes32, { value: creditPriceWei });
  return res.json({ orderId, orderIdBytes32, txHash: tx.hash });
});

app.get('/credits/order-status', async (req, res) => {
  const orderId = req.query.orderId as string | undefined;
  if (!orderId) {
    return res.status(400).json({ error: 'orderId required' });
  }
  const orderIdBytes32 = ethers.id(orderId);
  const orderIdHash = hashValue(orderIdBytes32);
  const orderResult = await query(
    'SELECT id FROM credit_orders WHERE order_id_hash = $1',
    [orderIdHash]
  );
  if (orderResult.rowCount === 0) {
    return res.json({ orderId, status: 'not_found' });
  }
  const depositResult = await query(
    'SELECT 1 FROM onchain_deposits WHERE order_id_hash = $1 LIMIT 1',
    [orderIdHash]
  );
  if (depositResult.rowCount > 0) {
    return res.json({ orderId, status: 'confirmed' });
  }
  return res.json({ orderId, status: 'pending' });
});

app.post('/runs/start', rateLimit('runs'), async (req, res) => {
  const wallet = getWalletAddress(req);
  if (!wallet) {
    return res.status(401).json({ error: 'x-wallet-address required' });
  }
  const walletHash = getWalletHash(wallet);
  const creditsWagered = Number(req.body.creditsWagered || 1);
  if (creditsWagered <= 0) {
    return res.status(400).json({ error: 'creditsWagered must be positive' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userResult = await client.query(
      'SELECT id, credit_balance_encrypted FROM users WHERE wallet_address_hash = $1 FOR UPDATE',
      [walletHash]
    );
    if (userResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'user not found' });
    }
    const user = userResult.rows[0];
    let currentBalance = decryptNumber(user.credit_balance_encrypted, 'credit_balance');
    if (currentBalance < creditsWagered) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'insufficient credits' });
    }
    const activeRun = await client.query(
      'SELECT run_id, created_at, credits_wagered FROM runs WHERE user_id = $1 AND status = $2 LIMIT 1 FOR UPDATE',
      [user.id, 'started']
    );
    if (activeRun.rowCount > 0) {
      const runAgeSeconds =
        (Date.now() - new Date(activeRun.rows[0].created_at as string).getTime()) / 1000;
      if (runAgeSeconds >= runTimeoutSeconds) {
        const refundRatio = Math.max(0, Math.min(1, runAbortRefundRatio));
        const refundCredits = Math.max(0, Math.floor(activeRun.rows[0].credits_wagered * refundRatio));
        await client.query(
          `UPDATE runs
           SET status = 'aborted', aborted_at = NOW()
           WHERE run_id = $1`,
          [activeRun.rows[0].run_id]
        );
        if (refundCredits > 0) {
          currentBalance += refundCredits;
          await client.query('UPDATE users SET credit_balance_encrypted = $1 WHERE id = $2', [
            encryptString(String(currentBalance)),
            user.id,
          ]);
          await client.query(
            `INSERT INTO credit_ledger (user_id, delta_encrypted, reason, metadata_encrypted)
             VALUES ($1, $2, 'run_abort_refund', $3)`,
            [user.id, encryptString(String(refundCredits)), encryptString(JSON.stringify({ reason: 'timeout' }))]
          );
        }
      } else {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'run already in progress' });
      }
    }
    const updatedBalanceEncrypted = encryptString(String(currentBalance - creditsWagered));

    await client.query(
      'UPDATE users SET credit_balance_encrypted = $1 WHERE id = $2',
      [updatedBalanceEncrypted, user.id]
    );
    await client.query(
      `INSERT INTO credit_ledger (user_id, delta_encrypted, reason, metadata_encrypted)
       VALUES ($1, $2, 'run_start', $3)`,
      [user.id, encryptString(String(-creditsWagered)), encryptString(JSON.stringify({ creditsWagered }))]
    );

    const runId = uuidv4();
    const runNonce = crypto.randomBytes(16).toString('hex');
    const multiplierLocked = 1;

    await client.query(
      `INSERT INTO runs (run_id, user_id, multiplier_locked, run_nonce, credits_wagered)
       VALUES ($1, $2, $3, $4, $5)`,
      [runId, user.id, multiplierLocked, runNonce, creditsWagered]
    );

    await client.query('COMMIT');
    return res.json({ runId, multiplierLocked, runNonce });
  } catch (error) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'run start failed' });
  } finally {
    client.release();
  }
});

app.post('/runs/finish', rateLimit('runs'), async (req, res) => {
  const wallet = getWalletAddress(req);
  if (!wallet) {
    return res.status(401).json({ error: 'x-wallet-address required' });
  }
  const walletHash = getWalletHash(wallet);

  const runId = req.body.runId as string | undefined;
  const rawScore = Number(req.body.rawScore || 0);
  const runNonce = req.body.runNonce as string | undefined;
  const checksum = req.body.checksum as string | undefined;
  const cleared = Boolean(req.body.cleared);

  if (!runId) {
    return res.status(400).json({ error: 'runId required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const runResult = await client.query(
      `SELECT runs.run_id, runs.status, runs.multiplier_locked, runs.user_id,
              runs.created_at, runs.run_nonce, users.wallet_address_hash
       FROM runs
       JOIN users ON users.id = runs.user_id
       WHERE runs.run_id = $1 FOR UPDATE`,
      [runId]
    );
    if (runResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'run not found' });
    }

    const run = runResult.rows[0];
    if (run.wallet_address_hash !== walletHash) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'run does not belong to wallet' });
    }

    if (run.status === 'finished') {
      await client.query('COMMIT');
      return res.json({ runId, status: 'finished' });
    }

    if (!runNonce || !checksum) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'runNonce and checksum required' });
    }
    if (run.run_nonce !== runNonce) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'runNonce mismatch' });
    }
    const expectedChecksum = buildRunChecksum(runId, rawScore, runNonce);
    if (checksum !== expectedChecksum) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'checksum mismatch' });
    }
    if (Number.isNaN(rawScore) || rawScore < 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'invalid rawScore' });
    }
    if (rawScore > maxRawScore) {
      console.warn('raw score exceeds max threshold', { runId, rawScore });
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'rawScore exceeds maximum' });
    }

    const startedAt = new Date(run.created_at);
    const durationSeconds = (Date.now() - startedAt.getTime()) / 1000;
    if (durationSeconds < minRunDurationSeconds) {
      console.warn('run finished too quickly', { runId, durationSeconds });
    }
    if (durationSeconds > maxRunDurationSeconds) {
      console.warn('run exceeded max duration', { runId, durationSeconds });
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'run duration exceeded maximum' });
    }

    const ticketsEarned = cleared ? baseTicketsPerClear * run.multiplier_locked : 0;

    await client.query(
      `UPDATE runs
       SET raw_score = $1,
           cleared = $2,
           tickets_earned = $3,
           checksum = $4,
           status = 'finished',
           finished_at = NOW()
       WHERE run_id = $5`,
      [rawScore, cleared, ticketsEarned, checksum, runId]
    );

    if (ticketsEarned > 0) {
      const userRow = await client.query(
        'SELECT raffle_tickets_total_encrypted FROM users WHERE id = $1 FOR UPDATE',
        [run.user_id]
      );
      if (userRow.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'user not found' });
      }
      const currentTickets = decryptNumber(userRow.rows[0].raffle_tickets_total_encrypted, 'raffle_tickets_total');
      const updatedTickets = encryptString(String(currentTickets + ticketsEarned));
      await client.query('UPDATE users SET raffle_tickets_total_encrypted = $1 WHERE id = $2', [
        updatedTickets,
        run.user_id,
      ]);
    }

    await client.query(
      `INSERT INTO leaderboards_cache (leaderboard_type, user_id, value)
       VALUES ('score', $1, $2), ('tickets', $1, $3)`,
      [run.user_id, rawScore, ticketsEarned]
    );

    await client.query('COMMIT');
    return res.json({ runId, rawScore, ticketsEarned, status: 'finished' });
  } catch (error) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'run finish failed' });
  } finally {
    client.release();
  }
});

app.post('/runs/abort', rateLimit('runs'), async (req, res) => {
  const wallet = getWalletAddress(req);
  if (!wallet) {
    return res.status(401).json({ error: 'x-wallet-address required' });
  }
  const walletHash = getWalletHash(wallet);
  const runId = req.body.runId as string | undefined;
  if (!runId) {
    return res.status(400).json({ error: 'runId required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const runResult = await client.query(
      `SELECT runs.run_id, runs.status, runs.user_id, runs.credits_wagered, users.wallet_address_hash,
              users.credit_balance_encrypted
       FROM runs
       JOIN users ON users.id = runs.user_id
       WHERE runs.run_id = $1 FOR UPDATE`,
      [runId]
    );
    if (runResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'run not found' });
    }
    const run = runResult.rows[0];
    if (run.wallet_address_hash !== walletHash) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'run does not belong to wallet' });
    }
    if (run.status !== 'started') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'run is not active' });
    }

    const refundRatio = Math.max(0, Math.min(1, runAbortRefundRatio));
    const refundCredits = Math.max(0, Math.floor(run.credits_wagered * refundRatio));
    if (refundCredits > 0) {
      const currentBalance = decryptNumber(run.credit_balance_encrypted, 'credit_balance');
      await client.query('UPDATE users SET credit_balance_encrypted = $1 WHERE id = $2', [
        encryptString(String(currentBalance + refundCredits)),
        run.user_id,
      ]);
      await client.query(
        `INSERT INTO credit_ledger (user_id, delta_encrypted, reason, metadata_encrypted)
         VALUES ($1, $2, 'run_abort_refund', $3)`,
        [run.user_id, encryptString(String(refundCredits)), encryptString(JSON.stringify({ reason: 'abort' }))]
      );
    }

    await client.query(
      `UPDATE runs
       SET status = 'aborted', aborted_at = NOW()
       WHERE run_id = $1`,
      [runId]
    );

    await client.query('COMMIT');
    return res.json({ runId, status: 'aborted', refundedCredits: refundCredits });
  } catch (error) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'run abort failed' });
  } finally {
    client.release();
  }
});

app.get('/leaderboards/score', async (_req, res) => {
  const result = await query(
    `SELECT users.wallet_address_encrypted, runs.raw_score
     FROM runs
     JOIN users ON users.id = runs.user_id
     WHERE runs.raw_score IS NOT NULL
     ORDER BY runs.raw_score DESC
     LIMIT 50`
  );
  const leaderboard = result.rows.map((row) => ({
    wallet_address: decryptString(row.wallet_address_encrypted),
    raw_score: row.raw_score,
  }));
  return res.json({ leaderboard });
});

app.get('/leaderboards/tickets', async (_req, res) => {
  const result = await query(
    `SELECT wallet_address_encrypted, raffle_tickets_total_encrypted
     FROM users`
  );
  const leaderboard = result.rows
    .map((row) => ({
      wallet_address: decryptString(row.wallet_address_encrypted),
      raffle_tickets_total: decryptNumber(row.raffle_tickets_total_encrypted, 'raffle_tickets_total'),
    }))
    .sort((a, b) => b.raffle_tickets_total - a.raffle_tickets_total)
    .slice(0, 50);
  return res.json({ leaderboard });
});

app.get('/skins/available', async (req, res) => {
  const wallet = getWalletAddress(req);
  if (!wallet) {
    return res.status(401).json({ error: 'x-wallet-address required' });
  }
  const walletHash = getWalletHash(wallet);
  const userResult = await query(
    'SELECT id, equipped_note_skin_id, equipped_gear_skin_id FROM users WHERE wallet_address_hash = $1',
    [walletHash]
  );
  if (userResult.rowCount === 0) {
    return res.status(404).json({ error: 'user not found' });
  }
  const user = userResult.rows[0];
  const skins = await query('SELECT * FROM skin_catalog ORDER BY skin_id');
  const unlocked = await query('SELECT skin_id FROM user_unlocked_skins WHERE user_id = $1', [user.id]);
  return res.json({
    skins: skins.rows,
    unlockedSkinIds: unlocked.rows.map((row) => row.skin_id),
    equipped_note_skin_id: user.equipped_note_skin_id,
    equipped_gear_skin_id: user.equipped_gear_skin_id,
  });
});

app.post('/skins/refresh', async (req, res) => {
  const wallet = getWalletAddress(req);
  if (!wallet) {
    return res.status(401).json({ error: 'x-wallet-address required' });
  }
  const walletHash = getWalletHash(wallet);
  const userResult = await query('SELECT id FROM users WHERE wallet_address_hash = $1', [walletHash]);
  if (userResult.rowCount === 0) {
    return res.status(404).json({ error: 'user not found' });
  }
  await ensureDefaultSkins();
  await ensureUserDefaults(userResult.rows[0].id);
  await refreshNftSkinsForUser(userResult.rows[0].id, wallet);
  return res.json({ status: 'refreshed' });
});

app.post('/skins/equip', async (req, res) => {
  const wallet = getWalletAddress(req);
  if (!wallet) {
    return res.status(401).json({ error: 'x-wallet-address required' });
  }
  const { skinId, skinType } = req.body as { skinId?: number; skinType?: string };
  if (!skinId || !skinType) {
    return res.status(400).json({ error: 'skinId and skinType required' });
  }
  const walletHash = getWalletHash(wallet);
  const userResult = await query('SELECT id FROM users WHERE wallet_address_hash = $1', [walletHash]);
  if (userResult.rowCount === 0) {
    return res.status(404).json({ error: 'user not found' });
  }
  const unlocked = await query(
    'SELECT 1 FROM user_unlocked_skins WHERE user_id = $1 AND skin_id = $2',
    [userResult.rows[0].id, skinId]
  );
  if (unlocked.rowCount === 0) {
    return res.status(403).json({ error: 'skin not unlocked' });
  }
  if (skinType === 'note') {
    await query('UPDATE users SET equipped_note_skin_id = $1 WHERE id = $2', [skinId, userResult.rows[0].id]);
  } else if (skinType === 'gear') {
    await query('UPDATE users SET equipped_gear_skin_id = $1 WHERE id = $2', [skinId, userResult.rows[0].id]);
  } else {
    return res.status(400).json({ error: 'invalid skinType' });
  }
  return res.json({ status: 'equipped' });
});

app.post('/admin/credits/adjust', async (req, res) => {
  const adminKey = req.header('x-admin-key');
  const expectedKey = requireEnv('ADMIN_API_KEY');
  if (!adminKey || adminKey !== expectedKey) {
    return res.status(403).json({ error: 'admin key invalid' });
  }

  const walletAddress = (req.body.walletAddress as string | undefined)
    ? normalizeWalletAddress(req.body.walletAddress)
    : undefined;
  const delta = Number(req.body.delta);
  if (!walletAddress || Number.isNaN(delta) || delta === 0) {
    return res.status(400).json({ error: 'walletAddress and non-zero delta required' });
  }

  const reason = (req.body.reason as string | undefined) || 'admin_adjustment';
  const walletHash = getWalletHash(walletAddress);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userResult = await client.query(
      'SELECT id, credit_balance_encrypted FROM users WHERE wallet_address_hash = $1 FOR UPDATE',
      [walletHash]
    );
    if (userResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'user not found' });
    }
    const user = userResult.rows[0];
    const currentBalance = decryptNumber(user.credit_balance_encrypted, 'credit_balance');
    const updatedBalance = currentBalance + delta;
    if (updatedBalance < 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'insufficient credits' });
    }

    await client.query('UPDATE users SET credit_balance_encrypted = $1 WHERE id = $2', [
      encryptString(String(updatedBalance)),
      user.id,
    ]);
    await client.query(
      `INSERT INTO credit_ledger (user_id, delta_encrypted, reason, metadata_encrypted)
       VALUES ($1, $2, $3, $4)`,
      [
        user.id,
        encryptString(String(delta)),
        reason,
        encryptString(JSON.stringify({ reason, admin: true })),
      ]
    );
    await client.query('COMMIT');
    return res.json({ walletAddress, credit_balance: updatedBalance });
  } catch (error) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'credit adjustment failed' });
  } finally {
    client.release();
  }
});

app.post('/admin/tickets/adjust', async (req, res) => {
  const adminKey = req.header('x-admin-key');
  const expectedKey = requireEnv('ADMIN_API_KEY');
  if (!adminKey || adminKey !== expectedKey) {
    return res.status(403).json({ error: 'admin key invalid' });
  }

  const walletAddress = (req.body.walletAddress as string | undefined)
    ? normalizeWalletAddress(req.body.walletAddress)
    : undefined;
  const delta = Number(req.body.delta);
  if (!walletAddress || Number.isNaN(delta) || delta === 0) {
    return res.status(400).json({ error: 'walletAddress and non-zero delta required' });
  }

  const walletHash = getWalletHash(walletAddress);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userResult = await client.query(
      'SELECT id, raffle_tickets_total_encrypted FROM users WHERE wallet_address_hash = $1 FOR UPDATE',
      [walletHash]
    );
    if (userResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'user not found' });
    }
    const user = userResult.rows[0];
    const currentTickets = decryptNumber(user.raffle_tickets_total_encrypted, 'raffle_tickets_total');
    const updatedTickets = currentTickets + delta;
    if (updatedTickets < 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'insufficient tickets' });
    }
    await client.query('UPDATE users SET raffle_tickets_total_encrypted = $1 WHERE id = $2', [
      encryptString(String(updatedTickets)),
      user.id,
    ]);
    await client.query('COMMIT');
    return res.json({ walletAddress, raffle_tickets_total: updatedTickets });
  } catch (error) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'ticket adjustment failed' });
  } finally {
    client.release();
  }
});

app.post('/admin/runs/invalidate', async (req, res) => {
  const adminKey = req.header('x-admin-key');
  const expectedKey = requireEnv('ADMIN_API_KEY');
  if (!adminKey || adminKey !== expectedKey) {
    return res.status(403).json({ error: 'admin key invalid' });
  }
  const runId = req.body.runId as string | undefined;
  if (!runId) {
    return res.status(400).json({ error: 'runId required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const runResult = await client.query(
      `SELECT runs.run_id, runs.status, runs.user_id, runs.tickets_earned,
              users.raffle_tickets_total_encrypted
       FROM runs
       JOIN users ON users.id = runs.user_id
       WHERE runs.run_id = $1 FOR UPDATE`,
      [runId]
    );
    if (runResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'run not found' });
    }
    const run = runResult.rows[0];
    if (run.status !== 'finished') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'run is not finished' });
    }
    const ticketsEarned = Number(run.tickets_earned || 0);
    if (ticketsEarned > 0) {
      const currentTickets = decryptNumber(run.raffle_tickets_total_encrypted, 'raffle_tickets_total');
      const updatedTickets = Math.max(0, currentTickets - ticketsEarned);
      await client.query('UPDATE users SET raffle_tickets_total_encrypted = $1 WHERE id = $2', [
        encryptString(String(updatedTickets)),
        run.user_id,
      ]);
    }
    await client.query(
      `UPDATE runs
       SET status = 'invalid', raw_score = NULL, tickets_earned = 0
       WHERE run_id = $1`,
      [runId]
    );
    await client.query('COMMIT');
    return res.json({ runId, status: 'invalid' });
  } catch (error) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'run invalidation failed' });
  } finally {
    client.release();
  }
});

const insecureLocal = allowInsecureLocal() && process.env.NODE_ENV !== 'production';
const server = insecureLocal
  ? createHttpServer(app)
  : createHttpsServer(loadServerTlsConfig(), app);
const wss = new WebSocketServer({ server });
const redisUrl = requireEnv('REDIS_URL');
const redisPassword = requireEnv('REDIS_PASSWORD');
enforceTlsUrl(redisUrl, 'REDIS_URL');
const redisTls = loadClientTlsConfig('REDIS');
const redisPub = new Redis(redisUrl, { password: redisPassword, tls: redisTls });
const redisSub = new Redis(redisUrl, { password: redisPassword, tls: redisTls });
const chatChannel = 'lobby-chat';

if (insecureLocal) {
  console.warn('HTTP/Ws enabled for local development only.');
} else {
  server.on('secureConnection', () => {
    console.log('HTTPS TLS connection established');
  });
}

redisPub.on('ready', () => {
  console.log('Redis TLS connection established (pub)');
});
redisSub.on('ready', () => {
  console.log('Redis TLS connection established (sub)');
});

redisSub.subscribe(chatChannel);

redisSub.on('message', (_channel, message) => {
  wss.clients.forEach((client) => {
    if (client.readyState === client.OPEN) {
      client.send(message);
    }
  });
});

wss.on('connection', (socket) => {
  socket.on('message', (data) => {
    redisPub.publish(chatChannel, data.toString());
  });
});

server.listen(port, () => {
  console.log(`API listening on ${port}`);
});
