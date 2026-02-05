import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import { pool, query } from './db.js';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import Redis from 'ioredis';

const app = express();
app.use(cors());
app.use(express.json());

const port = Number(process.env.PORT || 4000);
const baseTicketsPerClear = 1;
const defaultNoteSkinId = Number(process.env.DEFAULT_NOTE_SKIN_ID || 1);
const defaultGearSkinId = Number(process.env.DEFAULT_GEAR_SKIN_ID || 100);

function getWalletAddress(req: express.Request) {
  const headerWallet = req.header('x-wallet-address');
  return headerWallet?.toLowerCase() ?? null;
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

app.post('/auth/wallet-login', async (req, res) => {
  const walletAddress = (req.body.walletAddress as string | undefined)?.toLowerCase();
  if (!walletAddress) {
    return res.status(400).json({ error: 'walletAddress required' });
  }

  await ensureDefaultSkins();

  const upsert = await query<{ id: number }>(
    `INSERT INTO users (wallet_address, equipped_note_skin_id, equipped_gear_skin_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (wallet_address)
     DO UPDATE SET wallet_address = EXCLUDED.wallet_address
     RETURNING id`,
    [walletAddress, defaultNoteSkinId, defaultGearSkinId]
  );

  const userId = upsert.rows[0].id;
  await ensureUserDefaults(userId);

  const user = await query(
    `SELECT id, wallet_address, credit_balance, raffle_tickets_total,
            equipped_note_skin_id, equipped_gear_skin_id
     FROM users WHERE id = $1`,
    [userId]
  );

  return res.json({ user: user.rows[0] });
});

app.get('/me', async (req, res) => {
  const wallet = getWalletAddress(req);
  if (!wallet) {
    return res.status(401).json({ error: 'x-wallet-address required' });
  }
  const result = await query(
    `SELECT id, wallet_address, credit_balance, raffle_tickets_total,
            equipped_note_skin_id, equipped_gear_skin_id
     FROM users WHERE wallet_address = $1`,
    [wallet]
  );
  if (result.rowCount === 0) {
    return res.status(404).json({ error: 'user not found' });
  }
  return res.json({ user: result.rows[0] });
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
  const creditsWagered = Number(req.body.creditsWagered || 1);
  if (creditsWagered <= 0) {
    return res.status(400).json({ error: 'creditsWagered must be positive' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userResult = await client.query(
      'SELECT id, credit_balance FROM users WHERE wallet_address = $1 FOR UPDATE',
      [wallet]
    );
    if (userResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'user not found' });
    }
    const user = userResult.rows[0];
    if (user.credit_balance < creditsWagered) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'insufficient credits' });
    }

    await client.query(
      'UPDATE users SET credit_balance = credit_balance - $1 WHERE id = $2',
      [creditsWagered, user.id]
    );
    await client.query(
      `INSERT INTO credit_ledger (user_id, delta, reason, metadata)
       VALUES ($1, $2, 'run_start', $3)`,
      [user.id, -creditsWagered, JSON.stringify({ creditsWagered })]
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
              users.wallet_address
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
    if (run.wallet_address !== wallet) {
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
      await client.query(
        'UPDATE users SET raffle_tickets_total = raffle_tickets_total + $1 WHERE id = $2',
        [ticketsEarned, run.user_id]
      );
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
    `SELECT users.wallet_address, runs.raw_score
     FROM runs
     JOIN users ON users.id = runs.user_id
     WHERE runs.raw_score IS NOT NULL
     ORDER BY runs.raw_score DESC
     LIMIT 50`
  );
  return res.json({ leaderboard: result.rows });
});

app.get('/leaderboards/tickets', async (_req, res) => {
  const result = await query(
    `SELECT wallet_address, raffle_tickets_total
     FROM users
     ORDER BY raffle_tickets_total DESC
     LIMIT 50`
  );
  return res.json({ leaderboard: result.rows });
});

app.get('/skins/available', async (req, res) => {
  const wallet = getWalletAddress(req);
  if (!wallet) {
    return res.status(401).json({ error: 'x-wallet-address required' });
  }
  const userResult = await query('SELECT id, equipped_note_skin_id, equipped_gear_skin_id FROM users WHERE wallet_address = $1', [wallet]);
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
  const userResult = await query('SELECT id FROM users WHERE wallet_address = $1', [wallet]);
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
  const userResult = await query('SELECT id FROM users WHERE wallet_address = $1', [wallet]);
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

const server = createServer(app);
const wss = new WebSocketServer({ server });
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const redisPub = new Redis(redisUrl);
const redisSub = new Redis(redisUrl);
const chatChannel = 'lobby-chat';

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
