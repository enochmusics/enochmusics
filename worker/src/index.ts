import 'dotenv/config';
import { ethers } from 'ethers';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const chainId = Number(process.env.CHAIN_ID);
const confirmationsRequired = Number(process.env.CONFIRMATIONS_REQUIRED || 3);
const depositContractAddress = process.env.DEPOSIT_CONTRACT_ADDRESS ?? '';
const creditPriceWei = BigInt(process.env.CREDIT_PRICE_WEI || '1000000000000000');
const defaultNoteSkinId = Number(process.env.DEFAULT_NOTE_SKIN_ID || 1);
const defaultGearSkinId = Number(process.env.DEFAULT_GEAR_SKIN_ID || 100);

const depositAbi = [
  'event Deposit(address indexed payer, uint256 amountWei, bytes32 indexed orderId)',
];

async function ensureDefaultSkins() {
  await pool.query(
    `INSERT INTO skin_catalog (skin_id, skin_type, display_name, asset_ref)
     VALUES ($1, 'note', 'Default Note', 'note/default'),
            ($2, 'gear', 'Default Gear', 'gear/default')
     ON CONFLICT (skin_id) DO NOTHING`,
    [defaultNoteSkinId, defaultGearSkinId]
  );
}

async function ensureUserDefaults(userId: number) {
  await pool.query(
    `INSERT INTO user_unlocked_skins (user_id, skin_id)
     VALUES ($1, $2), ($1, $3)
     ON CONFLICT DO NOTHING`,
    [userId, defaultNoteSkinId, defaultGearSkinId]
  );
}

async function upsertUser(walletAddress: string) {
  await ensureDefaultSkins();
  const result = await pool.query<{ id: number }>(
    `INSERT INTO users (wallet_address, equipped_note_skin_id, equipped_gear_skin_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (wallet_address)
     DO UPDATE SET wallet_address = EXCLUDED.wallet_address
     RETURNING id`,
    [walletAddress, defaultNoteSkinId, defaultGearSkinId]
  );
  await ensureUserDefaults(result.rows[0].id);
  return result.rows[0].id;
}

async function processDeposits() {
  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl || !depositContractAddress) {
    throw new Error('RPC_URL and DEPOSIT_CONTRACT_ADDRESS required');
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
    const payer = (log.args?.payer as string).toLowerCase();
    const amountWei = log.args?.amountWei as bigint;
    const creditsToMint = Number(amountWei / creditPriceWei);
    if (creditsToMint <= 0) {
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const userId = await upsertUser(payer);
      const insertResult = await client.query(
        `INSERT INTO onchain_deposits (chain_id, tx_hash, log_index, amount_wei, credits_minted)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (chain_id, tx_hash, log_index) DO NOTHING
         RETURNING id`,
        [chainId, log.transactionHash, log.index, amountWei.toString(), creditsToMint]
      );
      if (insertResult.rowCount > 0) {
        await client.query(
          'UPDATE users SET credit_balance = credit_balance + $1 WHERE id = $2',
          [creditsToMint, userId]
        );
        await client.query(
          `INSERT INTO credit_ledger (user_id, delta, reason, metadata)
           VALUES ($1, $2, 'onchain_deposit', $3)`,
          [userId, creditsToMint, JSON.stringify({ txHash: log.transactionHash, logIndex: log.index })]
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
