import pg from 'pg';
import { enforceTlsUrl, requireEnv } from './security/secrets.js';
import { loadClientTlsConfig } from './security/tls.js';

const { Pool } = pg;

const databaseUrl = requireEnv('DATABASE_URL');
enforceTlsUrl(databaseUrl, 'DATABASE_URL');

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: loadClientTlsConfig('DATABASE'),
});

pool.on('connect', () => {
  console.log('DB TLS connection established');
});

export { pool };

export async function query<T>(text: string, params: unknown[] = []) {
  const result = await pool.query<T>(text, params);
  return result;
}
