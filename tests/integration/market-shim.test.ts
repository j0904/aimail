// Integration test: the market-compatible REST shim against a live HTTP server
// using the in-memory store. No Postgres or Credo required.
//
// This pins the request/response shapes to ../market/src/server.ts so the
// market can swap InMemoryMessageStore → aimail with no client changes.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:http';
import { InMemoryMessageStore } from '../../src/store/in-memory-store.js';
import { WsPushManager } from '../../src/transport/ws-push.js';
import { handleMarketShim } from '../../src/compat/market-shim.js';
import type { MediatorInfo } from '../../src/compat/market-shim.js';

const mediator: MediatorInfo = {
  did: 'did:key:mediator',
  endpoints: ['http://test'],
  invitationUrl: 'https://test/oob',
};

function startShimServer(): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const store = new InMemoryMessageStore();
  const push = new WsPushManager(store);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://test');
    const handled = await handleMarketShim(req, res, url.pathname, {
      store,
      push,
      mediator,
      startedAt: Date.now(),
    });
    if (!handled) {
      res.writeHead(404);
      res.end('{}');
    }
  });
  push.attach(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

async function req(
  base: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
}

describe('market-compatible REST shim', () => {
  let srv: { url: string; close: () => Promise<void> };

  beforeAll(async () => {
    srv = await startShimServer();
  });
  afterAll(async () => {
    await srv.close();
  });

  it('GET /api/health reports mediator did', async () => {
    const { status, json } = await req(srv.url, 'GET', '/api/health');
    expect(status).toBe(200);
    expect(json).toMatchObject({ status: 'ok', mediatorDid: 'did:key:mediator' });
  });

  it('GET /api/mediator returns discovery info', async () => {
    const { status, json } = await req(srv.url, 'GET', '/api/mediator');
    expect(status).toBe(200);
    expect(json).toMatchObject({ did: 'did:key:mediator', invitationUrl: 'https://test/oob' });
  });

  it('POST /api/messages without required fields is 400', async () => {
    const { status, json } = await req(srv.url, 'POST', '/api/messages', {
      senderDid: 'did:key:a',
    });
    expect(status).toBe(400);
    expect((json as { error: string }).error).toMatch(/required/);
  });

  it('POST → inbox → conversation → delete round-trips market shapes', async () => {
    const send = await req(srv.url, 'POST', '/api/messages', {
      schema: 'negotiation/proposal',
      senderDid: 'did:key:alice',
      recipientDid: 'did:key:bob',
      ciphertext: 'ENC(payload)',
      nonce: 'n-1',
    });
    expect(send.status).toBe(201);
    const sentId = (send.json as { id: string }).id;
    expect(sentId).toBeTruthy();

    const inbox = await req(srv.url, 'GET', '/api/messages/inbox/did:key:bob');
    expect(inbox.status).toBe(200);
    expect((inbox.json as { total: number }).total).toBe(1);
    expect((inbox.json as { messages: { ciphertext: string }[] }).messages[0].ciphertext).toBe('ENC(payload)');

    const conv = await req(srv.url, 'GET', '/api/messages/conversation/did:key:alice/did:key:bob');
    expect((conv.json as { total: number }).total).toBe(1);

    const del = await req(srv.url, 'DELETE', `/api/messages/${sentId}`);
    expect(del.status).toBe(200);
    expect(del.json).toMatchObject({ id: sentId, deleted: true });

    const after = await req(srv.url, 'GET', '/api/messages/inbox/did:key:bob');
    expect((after.json as { total: number }).total).toBe(0);
  });

  it('aimail-native: pending + ack', async () => {
    const send = await req(srv.url, 'POST', '/api/messages', {
      schema: 'negotiation/counter',
      senderDid: 'did:key:carol',
      recipientDid: 'did:key:dave',
      ciphertext: 'ENC2',
    });
    const id = (send.json as { id: string }).id;

    const pending = await req(srv.url, 'GET', '/api/messages/pending/did:key:dave');
    expect((pending.json as { total: number }).total).toBe(1);

    const ack = await req(srv.url, 'POST', `/api/messages/${id}/ack`);
    expect(ack.status).toBe(200);
    expect(ack.json).toMatchObject({ id, acked: true });

    const pendingAfter = await req(srv.url, 'GET', '/api/messages/pending/did:key:dave');
    expect((pendingAfter.json as { total: number }).total).toBe(0);
  });

  it('ack on unknown id is 404', async () => {
    const { status } = await req(srv.url, 'POST', '/api/messages/does-not-exist/ack');
    expect(status).toBe(404);
  });
});
