#!/usr/bin/env node
// aimail CLI.
//
//   aimail serve        — run the mediator + REST shim + WS push.
//   aimail did:create   — mint a fresh agent did:key + keypair (for tests/bootstrap).
//   aimail --help

import { loadConfig } from '../config.js';
import { generateEd25519KeyPair } from '../identity/keypair.js';
import { bytesToB64 } from '../mediator.js';
import { createMediator, type MediatorStateStore } from '../mediator.js';
import { createServer } from '../server.js';
import { InMemoryMessageStore } from '../store/in-memory-store.js';
import { PgMessageStore } from '../store/pg-store.js';
import { PgMediatorStateStore } from '../store/pg-mediator-state.js';
import type { MessageStore } from '../store/message-store.js';
import pg from 'pg';

async function main(): Promise<void> {
  const [cmd] = process.argv.slice(2);

  if (cmd === 'did:create') {
    await didCreate();
    return;
  }
  if (cmd === 'serve' || cmd === undefined) {
    await serve();
    return;
  }
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    printHelp();
    return;
  }
  console.error(`unknown command: ${cmd}`);
  printHelp();
  process.exit(2);
}

function printHelp(): void {
  console.log(`aimail — DIDComm v2 mediator & mailbox

Usage:
  aimail serve          Run the mediator server (default).
  aimail did:create     Mint a new agent did:key + keypair and print it.
  aimail --help         Show this help.

Configuration: see .env.example (AIMAIL_*, PG* env vars).`);
}

async function didCreate(): Promise<void> {
  const kp = await generateEd25519KeyPair();
  console.log(JSON.stringify({
    did: kp.did,
    publicKeyBase64: bytesToB64(kp.publicKey),
    privateKeyBase64: bytesToB64(kp.privateKey),
  }, null, 2));
}

async function serve(): Promise<void> {
  const config = loadConfig();

  // Choose store + state store based on whether Postgres is configured.
  // AIMAIL_DEV=1 forces the in-memory stores (no Postgres dependency).
  const dev = process.env.AIMAIL_DEV === '1';
  let store: MessageStore;
  let stateStore: MediatorStateStore;
  if (dev) {
    console.warn('[aimail] dev mode: in-memory stores (data lost on restart)');
    store = new InMemoryMessageStore();
    stateStore = memoryStateStore();
  } else {
    const pool = new pg.Pool({
      host: config.postgres.host,
      port: config.postgres.port,
      user: config.postgres.user,
      password: config.postgres.password,
      database: config.postgres.database,
    });
    const msgStore = new PgMessageStore(pool, { schema: config.postgres.schema });
    await msgStore.migrate();
    store = msgStore;
    const statePg = new PgMediatorStateStore(
      pool,
      config.postgres.schema,
      config.keyPassphrase,
    );
    await statePg.migrate();
    stateStore = statePg;
  }

  const mediator = await createMediator(config, store, stateStore);
  const server = await createServer(config, mediator, store);

  await server.start();
  console.log(`[aimail] mediator ready`);
  console.log(`[aimail]   DID:           ${mediator.did}`);
  console.log(`[aimail]   endpoints:     ${mediator.endpoints.join(', ')}`);
  console.log(`[aimail]   invitation:    ${mediator.invitationUrl}`);
  console.log(`[aimail]   REST + WS:     http port ${config.port} (ws /ws)`);

  // Graceful shutdown.
  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[aimail] ${sig} received, shutting down...`);
    try {
      await server.stop();
      console.log('[aimail] stopped.');
      process.exit(0);
    } catch (err) {
      console.error('[aimail] error during shutdown:', err);
      process.exit(1);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

/** Tiny in-memory state store for dev mode. */
function memoryStateStore(): MediatorStateStore {
  let saved: import('../mediator.js').SerializedKeyPair | null = null;
  return {
    async loadIdentity() {
      return saved;
    },
    async saveIdentity(kp) {
      saved = kp;
    },
  };
}

void main().catch((err) => {
  console.error('[aimail] fatal:', err);
  process.exit(1);
});
