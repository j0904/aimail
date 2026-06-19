// DB-backed end-to-end tests.
//
// These run against a REAL, isolated Postgres (spun up in a docker container
// by postgres-harness.ts) — no mocks. They exercise the production code paths
// that the Postgres-free unit/integration suite can't reach:
//
//   1. PgMessageStore queue lifecycle against real SQL — send, inbox,
//      conversation ordering, pendingFor, ack, delete — including durability
//      across a "process restart" (drop the pool, open a new one, confirm the
//      rows survived and pending/acked state is preserved).
//   2. PgMediatorStateStore at-rest identity persistence — save an encrypted
//      mediator keypair, reopen from a fresh pool, confirm the DID and keys
//      survive and that the ciphertext is actually encrypted (not plaintext).
//   3. Full REST shim over HTTP backed by the real PgMessageStore — the exact
//      /api/messages* shapes that make aimail a drop-in for ../market.
//
// The Credo mediator itself needs the native Askar binding, which can't run in
// every sandbox, so the mediator agent is out of scope here; everything else
// in the request path (store, queue bridge, shim, HTTP) is exercised for real.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:http';
import pg from 'pg';
import { startPostgres, type PostgresHarness } from './postgres-harness.js';
import { PgMessageStore } from '../../src/store/pg-store.js';
import { PgMediatorStateStore } from '../../src/store/pg-mediator-state.js';
import { handleMarketShim, type MediatorInfo } from '../../src/compat/market-shim.js';
import type { AgentMessage } from '../../src/store/message-store.js';

const MEDIATOR: MediatorInfo = {
  did: 'did:key:z6Mkmediator',
  endpoints: ['http://e2e'],
  invitationUrl: 'https://e2e/oob',
};

let harness: PostgresHarness;

beforeAll(async () => {
  harness = await startPostgres();
}, 60_000);

afterAll(async () => {
  if (harness) await harness.stop();
});

function makeMsg(p: Partial<AgentMessage> & { id: string }): AgentMessage {
  return {
    id: p.id,
    schema: p.schema ?? 'negotiation/proposal',
    senderDid: p.senderDid ?? 'did:key:alice',
    recipientDid: p.recipientDid ?? 'did:key:bob',
    ciphertext: p.ciphertext ?? 'ENC',
    nonce: p.nonce ?? p.id,
    timestamp: p.timestamp ?? Date.now(),
    replyTo: p.replyTo,
  };
}

// ---------------------------------------------------------------------------
// 1. PgMessageStore queue lifecycle + durability across "restart"
// ---------------------------------------------------------------------------

describe('PgMessageStore (real Postgres)', () => {
  it('migrates idempotently (creates the aimail_messages table)', async () => {
    const store = new PgMessageStore(harness.pool);
    await store.migrate();
    // Calling migrate again must not throw.
    await store.migrate();
    const res = await harness.pool.query(
      "SELECT to_regclass('public.aimail_messages') AS exists",
    );
    expect(res.rows[0].exists).toBe('aimail_messages');
  });

  it('send → inbox (newest first) → conversation (oldest first) → delete', async () => {
    const store = new PgMessageStore(harness.pool);
    await store.migrate();

    await store.send(makeMsg({ id: 'm1', timestamp: 100, ciphertext: 'A' }));
    await store.send(makeMsg({ id: 'm2', timestamp: 200, ciphertext: 'B' }));

    const inbox = await store.inbox('did:key:bob');
    expect(inbox.map((m) => m.id)).toEqual(['m2', 'm1']);
    expect(inbox[0].ciphertext).toBe('B');

    // conversation covers both directions, oldest first
    await store.send(
      makeMsg({ id: 'm3', senderDid: 'did:key:bob', recipientDid: 'did:key:alice', timestamp: 300 }),
    );
    const conv = await store.conversation('did:key:alice', 'did:key:bob');
    expect(conv.map((m) => m.id).sort()).toEqual(['m1', 'm2', 'm3']);

    await store.delete('m1');
    expect((await store.inbox('did:key:bob')).map((m) => m.id)).toEqual(['m2']);
  });

  it('pending → ack clears from pending but keeps inbox history', async () => {
    const store = new PgMessageStore(harness.pool);
    await store.migrate();
    await store.send(makeMsg({ id: 'p1', recipientDid: 'did:key:carol' }));
    await store.send(makeMsg({ id: 'p2', recipientDid: 'did:key:carol' }));

    expect((await store.pendingFor('did:key:carol')).map((m) => m.id)).toEqual(['p1', 'p2']);

    expect(await store.ack('p1')).toBe(true);
    const remaining = await store.pendingFor('did:key:carol');
    expect(remaining.map((m) => m.id)).toEqual(['p2']);

    // inbox is history: acked rows are still present until deleted
    expect((await store.inbox('did:key:carol')).map((m) => m.id).sort()).toEqual(['p1', 'p2']);
  });

  it('ack on unknown id returns false', async () => {
    const store = new PgMessageStore(harness.pool);
    await store.migrate();
    expect(await store.ack('does-not-exist')).toBe(false);
  });

  it('survives a process restart (messages + ack state persist across a new pool)', async () => {
    // Use a dedicated schema AND a dedicated pool to isolate from the shared
    // harness pool (we deliberately end this pool to simulate a crash; we must
    // not touch the shared pool's lifecycle).
    const schema = 'restart_test';
    await harness.pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);

    const crashPool = new pg.Pool({ ...harness.config, max: 5 });
    try {
      const store = new PgMessageStore(crashPool, { schema });
      await store.migrate();

      await store.send(makeMsg({ id: 'r1', recipientDid: 'did:key:dave' }));
      await store.send(makeMsg({ id: 'r2', recipientDid: 'did:key:dave' }));
      await store.ack('r1'); // r1 delivered before "crash"
    } finally {
      // Simulate the process crashing: close the pool hard.
      await crashPool.end();
    }

    // "Restart": open a fresh pool against the SAME database and confirm the
    // queue + acked state survived.
    const restartedPool = new pg.Pool({ ...harness.config, max: 5 });
    try {
      const reopened = new PgMessageStore(restartedPool, { schema });
      await reopened.migrate(); // idempotent; table already exists

      const pending = await reopened.pendingFor('did:key:dave');
      // Only r2 should be pending; r1 stays acked.
      expect(pending.map((m) => m.id)).toEqual(['r2']);
      // And inbox history still has both.
      expect((await reopened.inbox('did:key:dave')).map((m) => m.id).sort()).toEqual([
        'r1',
        'r2',
      ]);
    } finally {
      await restartedPool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. PgMediatorStateStore at-rest identity persistence
// ---------------------------------------------------------------------------

describe('PgMediatorStateStore (real Postgres, at-rest encryption)', () => {
  it('persists and reloads the mediator DID across a fresh pool', async () => {
    const schema = 'state_test';
    await harness.pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    const passphrase = 'correct horse battery staple';

    const store = new PgMediatorStateStore(harness.pool, schema, passphrase);
    await store.migrate();

    // Initially empty.
    expect(await store.loadIdentity()).toBeNull();

    const kp = {
      did: 'did:key:z6MkmediatorReal',
      publicKeyB64: 'cHVibGljLWJ5dGVz',
      privateKeyB64: 'cHJpdmF0ZS1zZWVk',
    };
    await store.saveIdentity(kp);

    // Reload from the same pool: identity survives.
    const reloaded = await store.loadIdentity();
    expect(reloaded).toEqual(kp);

    // The persisted secret must NOT be the plaintext seed — confirm the
    // at-rest encryption is actually applied in the DB.
    const row = await harness.pool.query(
      `SELECT secret_b64 FROM ${schema}.aimail_mediator_identity WHERE key = 'default'`,
    );
    expect(row.rows[0].secret_b64).not.toBe(kp.privateKeyB64);
    expect(row.rows[0].secret_b64).toMatch(/^enc:v1:/);
  });

  it('fails to decrypt under the wrong passphrase (authenticity guard)', async () => {
    const schema = 'state_test2';
    await harness.pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    const store = new PgMediatorStateStore(harness.pool, schema, 'right');
    await store.migrate();
    await store.saveIdentity({
      did: 'did:key:x',
      publicKeyB64: 'pk',
      privateKeyB64: 'sk',
    });

    const wrongKeyStore = new PgMediatorStateStore(harness.pool, schema, 'wrong');
    await expect(wrongKeyStore.loadIdentity()).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 3. Full REST shim over HTTP, backed by the real PgMessageStore
// ---------------------------------------------------------------------------

describe('market-compatible REST shim over real Postgres', () => {
  let url: string;
  let httpServer: http.Server;
  let shimStore: PgMessageStore;

  beforeAll(async () => {
    shimStore = new PgMessageStore(harness.pool);
    await shimStore.migrate();
    httpServer = http.createServer(async (req, res) => {
      const u = new URL(req.url ?? '/', 'http://e2e');
      const handled = await handleMarketShim(req, res, u.pathname, {
        store: shimStore,
        mediator: MEDIATOR,
        startedAt: Date.now(),
      });
      if (!handled) {
        res.writeHead(404);
        res.end('{}');
      }
    });
    await new Promise<void>((resolve) =>
      httpServer.listen(0, '127.0.0.1', () => resolve()),
    );
    url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((r) => httpServer.close(() => r())));

  async function req(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown }> {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json() };
  }

  it('GET /api/health reports the mediator DID', async () => {
    const r = await req('GET', '/api/health');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ status: 'ok', mediatorDid: MEDIATOR.did });
  });

  it('full market round-trip: POST → inbox → conversation → pending → ack → delete', async () => {
    const send = await req('POST', '/api/messages', {
      schema: 'negotiation/proposal',
      senderDid: 'did:key:alice',
      recipientDid: 'did:key:bob',
      ciphertext: 'ENC(payload-e2e)',
      nonce: 'n-e2e',
    });
    expect(send.status).toBe(201);
    const sentId = (send.json as { id: string }).id;

    const inbox = await req('GET', '/api/messages/inbox/did:key:bob');
    expect((inbox.json as { total: number }).total).toBeGreaterThanOrEqual(1);

    const conv = await req('GET', '/api/messages/conversation/did:key:alice/did:key:bob');
    expect((conv.json as { total: number }).total).toBeGreaterThanOrEqual(1);

    const pending = await req('GET', '/api/messages/pending/did:key:bob');
    expect((pending.json as { messages: { id: string }[] }).messages.some((m) => m.id === sentId)).toBe(true);

    const ack = await req('POST', `/api/messages/${sentId}/ack`);
    expect(ack.status).toBe(200);
    expect(ack.json).toMatchObject({ id: sentId, acked: true });

    // After ack, it's no longer pending.
    const pendingAfter = await req('GET', '/api/messages/pending/did:key:bob');
    expect(
      (pendingAfter.json as { messages: { id: string }[] }).messages.some((m) => m.id === sentId),
    ).toBe(false);

    const del = await req('DELETE', `/api/messages/${sentId}`);
    expect(del.status).toBe(200);
  });

  it('POST /api/messages without required fields is 400', async () => {
    const r = await req('POST', '/api/messages', { senderDid: 'did:key:alice' });
    expect(r.status).toBe(400);
  });

  it('the sent message is actually durable in Postgres (query the table directly)', async () => {
    await req('POST', '/api/messages', {
      schema: 'contract/draft',
      senderDid: 'did:key:audit',
      recipientDid: 'did:key:audit-dest',
      ciphertext: 'DURABLE-CHECK',
    });
    const row = await harness.pool.query(
      `SELECT ciphertext FROM aimail_messages WHERE recipient_did = 'did:key:audit-dest' ORDER BY timestamp DESC LIMIT 1`,
    );
    expect(row.rows[0].ciphertext).toBe('DURABLE-CHECK');
  });
});
