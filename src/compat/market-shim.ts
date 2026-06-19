// Market-compatible REST shim.
//
// Implements the EXACT same /api/messages* request/response shapes as
// ../market/src/server.ts (lines 186-223) so that ../market can switch from its
// InMemoryMessageStore to aimail by setting AIMAIL_URL and changing one
// factory line. No market protocol rewrite is required.
//
// Endpoints (identical to market):
//   POST   /api/messages                          -> { id, sent }
//   GET    /api/messages/inbox/:did               -> { messages, total }
//   GET    /api/messages/conversation/:didA/:didB -> { messages, total }
//   DELETE /api/messages/:id                      -> { id, deleted }
//
// aimail-native additions (not in market, do not collide):
//   GET    /api/messages/pending/:did             -> { messages, total }   (Pickup 2.0 pull view)
//   POST   /api/messages/:id/ack                  -> { id, acked }          (Pickup 2.0 ack)
//   GET    /api/mediator                          -> { did, endpoints, invitationUrl }
//   GET    /api/health                            -> { status, mediatorDid, uptime }

import { v4 as uuid } from 'uuid';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { MessageStore } from '../store/message-store.js';
import type { AgentMessage } from '../store/message-store.js';
import type { WsPushManager } from '../transport/ws-push.js';
import { isAgentMessage } from '../store/message-store.js';

export interface MediatorInfo {
  did: string;
  endpoints: string[];
  invitationUrl: string;
}

export interface ShimDeps {
  store: MessageStore;
  push?: WsPushManager;
  mediator: MediatorInfo;
  startedAt: number;
}

export function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

export function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Handle a market-compatible /api/* request. Returns true if the request was
 * handled (caller should not continue routing), false if it didn't match.
 */
export async function handleMarketShim(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  deps: ShimDeps,
): Promise<boolean> {
  const segments = path.split('/').filter(Boolean); // e.g. ['api','messages','inbox',did]

  // --- Health ---
  if (req.method === 'GET' && path === '/api/health') {
    json(res, 200, {
      status: 'ok',
      mediatorDid: deps.mediator.did,
      uptime: Math.floor((Date.now() - deps.startedAt) / 1000),
    });
    return true;
  }

  // --- Mediator discovery ---
  if (req.method === 'GET' && path === '/api/mediator') {
    json(res, 200, deps.mediator);
    return true;
  }

  // --- Send message (market-compatible) ---
  // POST /api/messages
  if (req.method === 'POST' && path === '/api/messages') {
    const body = await readBody(req);
    const msg: AgentMessage = {
      id: uuid(),
      schema: body.schema as AgentMessage['schema'],
      senderDid: body.senderDid as string,
      recipientDid: body.recipientDid as string,
      ciphertext: body.ciphertext as string,
      nonce: (body.nonce as string) ?? uuid(),
      timestamp: Date.now(),
      replyTo: body.replyTo as string,
    };
    if (!msg.senderDid || !msg.recipientDid || !msg.ciphertext) {
      json(res, 400, { error: 'senderDid, recipientDid, ciphertext required' });
      return true;
    }
    await deps.store.send(msg);
    // Live-push if the recipient is connected.
    if (deps.push) await deps.push.push(msg);
    json(res, 201, { id: msg.id, sent: true });
    return true;
  }

  // --- Inbox (market-compatible) ---
  // GET /api/messages/inbox/:did
  if (req.method === 'GET' && path.startsWith('/api/messages/inbox/')) {
    const did = decodeURIComponent(path.slice('/api/messages/inbox/'.length));
    const messages = await deps.store.inbox(did);
    json(res, 200, { messages, total: messages.length });
    return true;
  }

  // --- Conversation (market-compatible) ---
  // GET /api/messages/conversation/:didA/:didB
  if (req.method === 'GET' && path.startsWith('/api/messages/conversation/')) {
    const parts = path
      .slice('/api/messages/conversation/'.length)
      .split('/')
      .map((p) => decodeURIComponent(p));
    if (parts.length !== 2) {
      json(res, 400, { error: 'expected /api/messages/conversation/:didA/:didB' });
      return true;
    }
    const messages = await deps.store.conversation(parts[0], parts[1]);
    json(res, 200, { messages, total: messages.length });
    return true;
  }

  // --- Delete (market-compatible) ---
  // DELETE /api/messages/:id   (segments: ['api','messages',id])
  if (
    req.method === 'DELETE' &&
    segments.length === 3 &&
    segments[0] === 'api' &&
    segments[1] === 'messages'
  ) {
    const id = segments[2];
    await deps.store.delete(id);
    json(res, 200, { id, deleted: true });
    return true;
  }

  // --- aimail-native: Pickup 2.0 pull view ---
  // GET /api/messages/pending/:did
  if (req.method === 'GET' && path.startsWith('/api/messages/pending/')) {
    const did = decodeURIComponent(path.slice('/api/messages/pending/'.length));
    const messages = await deps.store.pendingFor(did);
    json(res, 200, { messages, total: messages.length });
    return true;
  }

  // --- aimail-native: Pickup 2.0 ack ---
  // POST /api/messages/:id/ack
  if (
    req.method === 'POST' &&
    segments.length === 4 &&
    segments[0] === 'api' &&
    segments[1] === 'messages' &&
    segments[3] === 'ack'
  ) {
    const id = segments[2];
    const ok = await deps.store.ack(id);
    if (!ok) {
      json(res, 404, { error: 'message not found or already acked' });
      return true;
    }
    json(res, 200, { id, acked: true });
    return true;
  }

  return false;
}

/** Re-export for consumers; prevents tree-shaking away the validator. */
export { isAgentMessage };
