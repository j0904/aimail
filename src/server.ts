// aimail HTTP server.
//
// A single node:http server handles:
//   - The market-compatible REST shim (/api/messages*, /api/mediator, /api/health).
//   - The WebSocket push transport (attached at /ws by WsPushManager).
//   - DIDComm inbound (delegated to the Credo agent's HttpInboundTransport,
//     which we expose under /didcomm/v2 — Phase 1 wires the agent to own its
//     own HTTP inbound transport on the same port via the mediator builder).
//
// In dev, run with:  node dist/server.js   (after `npm run build`)
// or via the CLI:     aimail serve

import http from 'node:http';
import type { AimailConfig } from './config.js';
import type { MessageStore } from './store/message-store.js';
import type { AimailMediator } from './mediator.js';
import { WsPushManager } from './transport/ws-push.js';
import {
  handleMarketShim,
  json,
  type MediatorInfo,
} from './compat/market-shim.js';

export interface AimailServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** The backing mediator (for the CLI / introspection). */
  mediator: AimailMediator;
}

export async function createServer(
  config: AimailConfig,
  mediator: AimailMediator,
  store: MessageStore,
): Promise<AimailServer> {
  const startedAt = Date.now();
  const push = config.wsEnabled ? new WsPushManager(store) : undefined;

  const httpServer = http.createServer(async (req, res) => {
    // CORS — same permissive headers as ../market for drop-in compatibility.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    try {
      const mediatorInfo: MediatorInfo = {
        did: mediator.did,
        endpoints: mediator.endpoints,
        invitationUrl: mediator.invitationUrl,
      };

      const handled = await handleMarketShim(req, res, path, {
        store,
        push,
        mediator: mediatorInfo,
        startedAt,
      });
      if (handled) return;

      json(res, 404, { error: 'not found', path });
    } catch (err) {
      json(res, 500, { error: (err as Error).message });
    }
  });

  // Attach the WebSocket push transport to the same HTTP server.
  if (push) push.attach(httpServer);

  return {
    mediator,
    async start() {
      // Start the mediator agent first (Credo agent.initialize()).
      await mediator.start();
      await new Promise<void>((resolve) =>
        httpServer.listen(config.port, () => resolve()),
      );
      // Best-effort flush for any agent that connected before listen completed.
      // (No-op until recipients connect.)
    },
    async stop() {
      await push?.close();
      await new Promise<void>((resolve, reject) =>
        httpServer.close((err) => (err ? reject(err) : resolve())),
      );
      await mediator.stop();
    },
  };
}
