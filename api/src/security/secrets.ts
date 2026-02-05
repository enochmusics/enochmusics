export function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export function allowInsecureLocal() {
  return process.env.ALLOW_INSECURE_LOCAL === 'true';
}

export function isLocalhost(hostname: string) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

export function enforceTlsUrl(rawUrl: string, label: string) {
  const allowInsecure = allowInsecureLocal() && process.env.NODE_ENV !== 'production';
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch (error) {
    throw new Error(`${label} must be a valid URL`);
  }

  if (parsed.protocol === 'https:' || parsed.protocol === 'wss:' || parsed.protocol === 'rediss:') {
    return;
  }

  if (allowInsecure && (parsed.protocol === 'http:' || parsed.protocol === 'ws:' || parsed.protocol === 'redis:') && isLocalhost(parsed.hostname)) {
    return;
  }

  throw new Error(`${label} must use TLS (https/wss/rediss). Set ALLOW_INSECURE_LOCAL=true for localhost only.`);
}
