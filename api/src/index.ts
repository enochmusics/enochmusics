import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
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

app.post('/auth/wallet-login', async (req, res) => {
  const walletAddress = (req.body.walletAddress as string | undefined)
    ? normalizeWalletAddress(req.body.walletAddress)
    : undefined;
  if (!walletAddress) {
    return res.status(400).json({ error: 'walletAddress required' });
  }

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

  const user = await query(
    `SELECT id, wallet_address_encrypted, credit_balance_encrypted, raffle_tickets_total_encrypted,
            equipped_note_skin_id, equipped_gear_skin_id
     FROM users WHERE id = $1`,
    [userId]
  );

  return res.json({ user: mapUserRow(user.rows[0]) });
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

app.post('/credits/create-order', async (req, res) => {
  const wallet = getWalletAddress(req);
  if (!wallet) {
    return res.status(401).json({ error: 'x-wallet-address required' });
  }
  const orderId = uuidv4();
  return res.json({ orderId });
});

app.get('/credits/order-status', async (req, res) => {
  const orderId = req.query.orderId as string | undefined;
  if (!orderId) {
    return res.status(400).json({ error: 'orderId required' });
  }
  return res.json({ orderId, status: 'pending' });
});

app.post('/runs/start', async (req, res) => {
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
    const currentBalance = decryptNumber(user.credit_balance_encrypted, 'credit_balance');
    if (currentBalance < creditsWagered) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'insufficient credits' });
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
    const multiplierLocked = 1;

    await client.query(
      `INSERT INTO runs (run_id, user_id, multiplier_locked)
       VALUES ($1, $2, $3)`,
      [runId, user.id, multiplierLocked]
    );

    await client.query('COMMIT');
    return res.json({ runId, multiplierLocked });
  } catch (error) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'run start failed' });
  } finally {
    client.release();
  }
});

app.post('/runs/finish', async (req, res) => {
  const wallet = getWalletAddress(req);
  if (!wallet) {
    return res.status(401).json({ error: 'x-wallet-address required' });
  }
  const walletHash = getWalletHash(wallet);

  const runId = req.body.runId as string | undefined;
  const rawScore = Number(req.body.rawScore || 0);
  const cleared = Boolean(req.body.cleared);

  if (!runId) {
    return res.status(400).json({ error: 'runId required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const runResult = await client.query(
      `SELECT runs.run_id, runs.status, runs.multiplier_locked, runs.user_id,
              users.wallet_address_hash
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

    const ticketsEarned = cleared ? baseTicketsPerClear * run.multiplier_locked : 0;

    await client.query(
      `UPDATE runs
       SET raw_score = $1,
           cleared = $2,
           tickets_earned = $3,
           status = 'finished',
           finished_at = NOW()
       WHERE run_id = $4`,
      [rawScore, cleared, ticketsEarned, runId]
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
