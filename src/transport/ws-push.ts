// WebSocket push manager: delivers queued messages live to connected agents.
//
// When a recipient agent is connected over WebSocket, the mediator pushes
// newly-arrived messages immediately rather than waiting for a Pickup 2.0 pull.
// When offline, messages stay queued in the MessageStore and are pulled later.
//
// Auth: a recipient authenticates by opening the WS with an `Authorization:
// Bearer <did-jwt>` header (a self-signed JWS over its own DID). On connect
// the manager registers the socket under that DID and flushes any pending
// queue. On disconnect the registration is dropped.

import { WebSocketServer, WebSocket } from 'ws';
import type { AgentMessage, MessageStore } from '../store/message-store.js';

export interface WsPushOptions {
  /** Path to mount the push endpoint on (default '/ws'). */
  path?: string;
  /** Optional hook to verify the bearer token → recipient DID. */
  authenticate?: (token: string) => Promise<string | null>;
}

/** A frame pushed to a connected agent. */
export interface PushFrame {
  type: 'message';
  message: AgentMessage;
}

/**
 * Owns the WebSocketServer and the recipient-DID → socket map. On a new
 * message arriving for a connected DID, push it immediately.
 */
export class WsPushManager {
  private wss: WebSocketServer | null = null;
  /** recipient DID → active sockets (an agent may hold several connections). */
  private readonly sockets = new Map<string, Set<WebSocket>>();

  constructor(
    private store: MessageStore,
    private options: WsPushOptions = {},
  ) {}

  /** Attach to an existing HTTP server (so we share the port with the REST shim). */
  attach(server: import('node:http').Server): void {
    this.wss = new WebSocketServer({
      server,
      path: this.options.path ?? '/ws',
      verifyClient: async (info, next) => {
        const did = await this.authenticate(info.req.headers.authorization);
        if (!did) {
          next(false, 401, 'unauthorized');
          return;
        }
        // Stash the DID on the request for the 'connection' handler.
        (info.req as { __aimailDid?: string }).__aimailDid = did;
        next(true);
      },
    });

    this.wss.on('connection', (ws, req) => {
      const did = (req as { __aimailDid?: string }).__aimailDid;
      if (!did) {
        ws.close(1008, 'unauthorized');
        return;
      }
      this.register(did, ws);
      // Flush any messages queued while the agent was offline.
      void this.flush(did);
    });
  }

  /** Default auth: a no-op accepting any bearer token when none is configured. */
  private async authenticate(header: string | undefined): Promise<string | null> {
    if (!header) return null;
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) return null;
    if (this.options.authenticate) {
      return this.options.authenticate(match[1]);
    }
    // Without an authenticator configured, the token IS the DID (dev mode).
    const did = match[1].trim();
    return /^did:/.test(did) ? did : null;
  }

  private register(did: string, ws: WebSocket): void {
    let set = this.sockets.get(did);
    if (!set) {
      set = new Set();
      this.sockets.set(did, set);
    }
    set.add(ws);
    ws.on('close', () => {
      const s = this.sockets.get(did);
      if (!s) return;
      s.delete(ws);
      if (s.size === 0) this.sockets.delete(did);
    });
    ws.on('error', () => {
      try { ws.close(); } catch { /* ignore */ }
    });
  }

  /** Is the recipient currently online (one or more open sockets)? */
  isOnline(did: string): boolean {
    const s = this.sockets.get(did);
    return !!s && s.size > 0;
  }

  /**
   * Push a message to a recipient's sockets if online; return true if
   * delivered live, false if it must stay in the queue for later pickup.
   */
  async push(msg: AgentMessage): Promise<boolean> {
    const set = this.sockets.get(msg.recipientDid);
    if (!set || set.size === 0) return false;
    const frame: PushFrame = { type: 'message', message: msg };
    const payload = JSON.stringify(frame);
    let delivered = false;
    for (const ws of set) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
        delivered = true;
      }
    }
    return delivered;
  }

  /** Deliver all pending messages for a DID (called on connect/reconnect). */
  async flush(did: string): Promise<number> {
    const pending = await this.store.pendingFor(did);
    let n = 0;
    for (const msg of pending) {
      if (await this.push(msg)) n++;
    }
    return n;
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.wss) {
        resolve();
        return;
      }
      this.wss.close(() => resolve());
      this.sockets.clear();
      this.wss = null;
    });
  }
}
