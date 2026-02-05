import 'dotenv/config';
import { ethers } from 'ethers';
import pg from 'pg';
import { decryptString, encryptString, hashValue } from './security/encryption.js';
import { enforceTlsUrl, requireEnv } from './security/secrets.js';
import { loadClientTlsConfig } from './security/tls.js';

const { Pool } = pg;
const databaseUrl = requireEnv('DATABASE_URL');
enforceTlsUrl(databaseUrl, 'DATABASE_URL');
const pool = new Pool({ connectionString: databaseUrl, ssl: loadClientTlsConfig('DATABASE') });

pool.on('connect', () => {
  console.log('DB TLS connection established (worker)');
});

const chainId = Number(process.env.CHAIN_ID);
const confirmationsRequired = Number(process.env.CONFIRMATIONS_REQUIRED || 3);
const depositContractAddress = process.env.DEPOSIT_CONTRACT_ADDRESS ?? '';
const creditPriceWei = BigInt(process.env.CREDIT_PRICE_WEI || '1000000000000000');
const defaultNoteSkinId = Number(process.env.DEFAULT_NOTE_SKIN_ID || 1);
const defaultGearSkinId = Number(process.env.DEFAULT_GEAR_SKIN_ID || 100);

const depositAbi = [
  'event Deposit(address indexed payer, uint256 amountWei, bytes32 indexed orderId)',
];

function normalizeWalletAddress(value: string) {
  return value.toLowerCase();
}

function decryptNumber(value: string, label: string) {
  const parsed = Number(decryptString(value));
  if (Number.isNaN(parsed)) {
    throw new Error(`${label} decrypt failed`);
  }
  return parsed;
}

async function ensureDefaultSkins(client: pg.PoolClient) {
  await client.query(
    `INSERT INTO skin_catalog (skin_id, skin_type, display_name, asset_ref)
     VALUES ($1, 'note', 'Default Note', 'note/default'),
            ($2, 'gear', 'Default Gear', 'gear/default')
     ON CONFLICT (skin_id) DO NOTHING`,
    [defaultNoteSkinId, defaultGearSkinId]
  );
}

async function ensureUserDefaults(client: pg.PoolClient, userId: number) {
  await client.query(
    `INSERT INTO user_unlocked_skins (user_id, skin_id)
     VALUES ($1, $2), ($1, $3)
     ON CONFLICT DO NOTHING`,
    [userId, defaultNoteSkinId, defaultGearSkinId]
  );
}

async function upsertUser(client: pg.PoolClient, walletAddress: string) {
  await ensureDefaultSkins(client);
  const normalizedWallet = normalizeWalletAddress(walletAddress);
  const walletHash = hashValue(normalizedWallet);
  const walletEncrypted = encryptString(normalizedWallet);
  const creditBalanceEncrypted = encryptString('0');
  const raffleTicketsEncrypted = encryptString('0');
  const result = await client.query<{ id: number }>(
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
  await ensureUserDefaults(client, result.rows[0].id);
  return result.rows[0].id;
}

async function processDeposits() {
  const rpcUrl = requireEnv('RPC_URL');
  enforceTlsUrl(rpcUrl, 'RPC_URL');
  if (!depositContractAddress) {
    throw new Error('DEPOSIT_CONTRACT_ADDRESS required');
  }
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const contract = new ethers.Contract(depositContractAddress, depositAbi, provider);

  const latestBlock = await provider.getBlockNumber();
  const fromBlock = Math.max(latestBlock - 5000, 0);
  const toBlock = latestBlock - confirmationsRequired;
  if (toBlock <= fromBlock) {
    return;
  }

  const logs = await contract.queryFilter(contract.filters.Deposit(), fromBlock, toBlock);

  for (const log of logs) {
    const payer = normalizeWalletAddress(log.args?.payer as string);
    const amountWei = log.args?.amountWei as bigint;
    const creditsToMint = Number(amountWei / creditPriceWei);
    if (creditsToMint <= 0) {
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const userId = await upsertUser(client, payer);
      const txHash = log.transactionHash;
      const txHashHash = hashValue(txHash);
      const txHashEncrypted = encryptString(txHash);
      const amountWeiEncrypted = encryptString(amountWei.toString());
      const creditsEncrypted = encryptString(String(creditsToMint));
      const insertResult = await client.query(
        `INSERT INTO onchain_deposits (
            chain_id,
            tx_hash_encrypted,
            tx_hash_hash,
            log_index,
            amount_wei_encrypted,
            credits_minted_encrypted
         )
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (chain_id, tx_hash_hash, log_index) DO NOTHING
         RETURNING id`,
        [chainId, txHashEncrypted, txHashHash, log.index, amountWeiEncrypted, creditsEncrypted]
      );
      if (insertResult.rowCount > 0) {
        const balanceResult = await client.query(
          'SELECT credit_balance_encrypted FROM users WHERE id = $1 FOR UPDATE',
          [userId]
        );
        if (balanceResult.rowCount === 0) {
          throw new Error('user not found while crediting deposit');
        }
        const currentBalance = decryptNumber(balanceResult.rows[0].credit_balance_encrypted, 'credit_balance');
        const updatedBalance = encryptString(String(currentBalance + creditsToMint));
        await client.query('UPDATE users SET credit_balance_encrypted = $1 WHERE id = $2', [
          updatedBalance,
          userId,
        ]);
        await client.query(
          `INSERT INTO credit_ledger (user_id, delta_encrypted, reason, metadata_encrypted)
           VALUES ($1, $2, 'onchain_deposit', $3)`,
          [
            userId,
            encryptString(String(creditsToMint)),
            encryptString(JSON.stringify({ txHash, logIndex: log.index })),
          ]
        );
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  }
}

async function main() {
  while (true) {
    try {
      await processDeposits();
    } catch (error) {
      console.error('deposit worker error', error);
    }
    await new Promise((resolve) => setTimeout(resolve, 10000));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
