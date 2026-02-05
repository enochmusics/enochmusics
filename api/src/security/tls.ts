import fs from 'fs';

type TlsPaths = {
  caPath?: string;
  certPath?: string;
  keyPath?: string;
};

type TlsPem = {
  ca?: string;
  cert?: string;
  key?: string;
};

function readOptionalFile(path?: string) {
  if (!path) return undefined;
  return fs.readFileSync(path, 'utf8');
}

export function loadTlsPem(paths: TlsPaths): TlsPem {
  return {
    ca: readOptionalFile(paths.caPath),
    cert: readOptionalFile(paths.certPath),
    key: readOptionalFile(paths.keyPath),
  };
}

export function loadServerTlsConfig() {
  const paths: TlsPaths = {
    caPath: process.env.TLS_CA_PATH,
    certPath: process.env.TLS_CERT_PATH,
    keyPath: process.env.TLS_KEY_PATH,
  };

  const pem = loadTlsPem(paths);
  if (!pem.cert || !pem.key) {
    throw new Error('TLS_CERT_PATH and TLS_KEY_PATH are required for HTTPS');
  }
  return pem;
}

export function loadClientTlsConfig(prefix: string) {
  const pem = loadTlsPem({
    caPath: process.env[`${prefix}_CA_PATH`],
    certPath: process.env[`${prefix}_CERT_PATH`],
    keyPath: process.env[`${prefix}_KEY_PATH`],
  });

  return {
    rejectUnauthorized: true,
    ...pem,
  };
}
