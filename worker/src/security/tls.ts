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
