import crypto from 'crypto';

type Keyring = {
  primaryId: string;
  keys: Map<string, Buffer>;
};

function parseKeySpec(spec: string): [string, Buffer] {
  const [id, key] = spec.split(':');
  if (!id || !key) {
    throw new Error('Invalid ENCRYPTION_KEYS entry; expected id:base64');
  }
  const decoded = Buffer.from(key, 'base64');
  if (decoded.length !== 32) {
    throw new Error(`Encryption key ${id} must be 32 bytes (base64)`);
  }
  return [id, decoded];
}

function loadKeyring(): Keyring {
  const keysEnv = process.env.ENCRYPTION_KEYS;
  const legacyKey = process.env.ENCRYPTION_KEY;
  const legacyId = process.env.ENCRYPTION_KEY_ID || 'primary';

  const entries: [string, Buffer][] = [];
  if (keysEnv) {
    for (const part of keysEnv.split(',')) {
      if (!part.trim()) continue;
      entries.push(parseKeySpec(part.trim()));
    }
  } else if (legacyKey) {
    entries.push([legacyId, Buffer.from(legacyKey, 'base64')]);
  }

  if (entries.length === 0) {
    throw new Error('ENCRYPTION_KEYS (or ENCRYPTION_KEY) must be set');
  }

  const [primaryId] = entries[0];
  const keys = new Map(entries);
  return { primaryId, keys };
}

const keyring = loadKeyring();

export function hashValue(value: string) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function encryptString(plaintext: string) {
  try {
    const iv = crypto.randomBytes(12);
    const key = keyring.keys.get(keyring.primaryId);
    if (!key) {
      throw new Error('Primary encryption key not available');
    }
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const payload = Buffer.concat([iv, tag, ciphertext]).toString('base64');
    return `v1:${keyring.primaryId}:${payload}`;
  } catch (error) {
    console.error('Encryption error', error instanceof Error ? error.message : error);
    throw error;
  }
}

export function decryptString(payload: string) {
  try {
    const parts = payload.split(':');
    let keyId: string | undefined;
    let encoded = payload;

    if (parts.length === 3 && parts[0] === 'v1') {
      [, keyId, encoded] = parts;
    }

    const candidates = keyId ? [keyId] : Array.from(keyring.keys.keys());
    for (const candidateId of candidates) {
      const key = keyring.keys.get(candidateId);
      if (!key) continue;
      try {
        const buffer = Buffer.from(encoded, 'base64');
        const iv = buffer.subarray(0, 12);
        const tag = buffer.subarray(12, 28);
        const ciphertext = buffer.subarray(28);
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
        return plaintext;
      } catch {
        continue;
      }
    }

    throw new Error('Unable to decrypt payload with available keys');
  } catch (error) {
    console.error('Decryption error', error instanceof Error ? error.message : error);
    throw error;
  }
}
