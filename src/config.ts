// aimail runtime configuration, loaded from environment variables.
// All values have safe dev defaults so `aimail serve` works out of the box;
// production deployments must override the secrets and public URL.

export interface AimailConfig {
  /** HTTP port for REST shim + DIDComm inbound. */
  port: number;
  /** Public base URL advertised in the mediator DID document serviceEndpoint. */
  publicUrl: string;
  /** Enable WebSocket push transport for online agents. */
  wsEnabled: boolean;
  /** DID method the mediator itself uses ('key' | 'web'). */
  didMethod: 'key' | 'web';
  /** Postgres connection (shared with ../market by default). */
  postgres: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
    schema: string;
  };
  /** Passphrase for at-rest encryption of mediator secrets. */
  keyPassphrase: string;
  /** Auto-grant all incoming mediate-request messages. */
  autoGrantMediation: boolean;
}

function requiredEnv(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) ? fallback : n;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes';
}

export function loadConfig(): AimailConfig {
  const didMethod = requiredEnv('AIMAIL_DID_METHOD', 'key');
  if (didMethod !== 'key' && didMethod !== 'web') {
    throw new Error(`AIMAIL_DID_METHOD must be 'key' or 'web', got '${didMethod}'`);
  }
  return {
    port: intEnv('AIMAIL_PORT', 3080),
    publicUrl: requiredEnv('AIMAIL_PUBLIC_URL', 'http://localhost:3080'),
    wsEnabled: boolEnv('AIMAIL_WS_ENABLED', true),
    didMethod,
    postgres: {
      host: requiredEnv('PGHOST', 'localhost'),
      port: intEnv('PGPORT', 5432),
      user: requiredEnv('PGUSER', 'marketplace'),
      password: requiredEnv('PGPASSWORD', 'marketplace'),
      database: requiredEnv('PGDATABASE', 'marketplace'),
      schema: requiredEnv('AIMAIL_PG_SCHEMA', 'public'),
    },
    keyPassphrase: requiredEnv('AIMAIL_KEY_PASSPHRASE', ''),
    autoGrantMediation: boolEnv('AIMAIL_AUTO_GRANT_MEDIATION', true),
  };
}
