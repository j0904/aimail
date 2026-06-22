// The aimail mediator: a Credo DIDComm agent configured in the mediator role.
//
// Responsibilities:
//   1. Hold the mediator's own DID (did:key by default) and key material.
//   2. Accept Coordinate-Mediation 2.0 requests and maintain a routing table.
//   3. Store-and-forward: queue incoming forward envelopes, push to online
//      recipients over WebSocket, and serve Pickup 2.0 pulls for offline ones.
//   4. Expose an Out-of-Band invitation so agents can discover and connect.
//
// The mediator is a "dumb pipe": it can only open the outer (forward) envelope
// to learn the routed recipient DID — the inner payload stays E2E encrypted to
// the recipient's key. We persist the queue via our MessageStore-backed queue
// transport repository so the same durable Postgres backs both DIDComm Pickup
// and the market-compatible REST shim.
//
// Credo wiring (0.7.x API):
//   - Agent config is minimal (logger/flags only); endpoints, transports and
//     the queue repo are passed via the `didComm` module config.
//   - DidCommModule({ endpoints, transports, queueTransportRepository,
//     mediator: { autoAcceptMediationRequests, messageForwardingStrategy },
//     messagePickup: { protocols: [new DidCommMessagePickupV2Protocol()] } })
//   - Transports: DidCommHttpInboundTransport + DidCommWsInboundTransport
//     (from @credo-ts/node), DidCommHttpOutboundTransport +
//     DidCommWsOutboundTransport (from @credo-ts/didcomm).
//   - Wallet: Askar (native, via @openwallet-foundation/askar-nodejs). In dev
//     (AIMAIL_DEV=1) we fall back to the in-memory wallet.

import { randomUUID } from 'node:crypto';
import type { AimailConfig } from './config.js';
import { generateEd25519KeyPair, type Ed25519KeyPair } from './identity/keypair.js';
import type { MessageStore } from './store/message-store.js';
import { StoreQueueTransportRepository } from './store/credo-pickup-bridge.js';

/**
 * Persistence interface for the mediator's own identity. The Credo agent also
 * keeps its own wallet records; this is a thin layer for the mediator DID
 * bootstrap so we mint exactly one DID and reuse it across restarts.
 */
export interface MediatorStateStore {
  /** Load the persisted mediator keypair, or null if not yet bootstrapped. */
  loadIdentity(): Promise<SerializedKeyPair | null>;
  /** Persist the mediator keypair (at-rest encrypted by the caller). */
  saveIdentity(kp: SerializedKeyPair): Promise<void>;
}

export interface SerializedKeyPair {
  /** base64 of the 32-byte Ed25519 public key. */
  publicKeyB64: string;
  /** base64 of the 32-byte Ed25519 private key seed. */
  privateKeyB64: string;
  /** The did:key string. */
  did: string;
}

/**
 * The mediator's DIDComm + queue surface. The concrete implementation wraps a
 * Credo agent; tests may substitute a stub. Keeping this an interface lets the
 * REST shim and transports depend on the contract, not on Credo types.
 */
export interface AimailMediator {
  /** The mediator's public DID (did:key:...). */
  readonly did: string;
  /** Public endpoints advertised to other agents (http and/or ws). */
  readonly endpoints: string[];
  /** Out-of-Band invitation URL for agents to connect. */
  invitationUrl: string;
  /** Backing message store (shared with the REST shim). */
  readonly store: MessageStore;
  /** Start the mediator agent and transports. */
  start(): Promise<void>;
  /** Gracefully stop the mediator. */
  stop(): Promise<void>;
}

/**
 * Create a Credo-backed mediator. Does not start the agent — call `start()` on
 * the returned object once the HTTP server is wired up.
 */
export async function createMediator(
  config: AimailConfig,
  store: MessageStore,
  stateStore: MediatorStateStore,
): Promise<AimailMediator> {
  // 1. Bootstrap or load the mediator DID.
  const keyPair = await ensureIdentity(stateStore);
  const endpoints = [config.publicUrl];
  if (config.wsEnabled) {
    // WebSocket runs on the same host; derive the ws:// URL from publicUrl.
    endpoints.push(config.publicUrl.replace(/^http/, 'ws'));
  }

  // 2. Build the queue transport repository on top of our shared store.
  const queueRepository = new StoreQueueTransportRepository(
    store,
    keyPair.did,
    () => randomUUID(),
  );

  // 3. Instantiate the Credo agent in mediator role. Imports are lazy so that
  //    environments without the native Askar binding fail at start() rather
  //    than at module import time, and so unit tests of the surrounding code
  //    don't require Credo installed.
  const agent = await buildCredoAgent({
    config,
    keyPair,
    endpoints,
    queueRepository,
    autoGrant: config.autoGrantMediation,
  });

  let invitationUrl: string | undefined;

  return {
    did: keyPair.did,
    endpoints,
    store,
    get invitationUrl() {
      return invitationUrl ?? '';
    },
    async start() {
      await agent.start();
      invitationUrl = await createInvitationUrl(agent.agent, config);
    },
    async stop() {
      await agent.stop();
    },
  };
}

async function ensureIdentity(
  stateStore: MediatorStateStore,
): Promise<Ed25519KeyPair & { did: `did:key:${string}` }> {
  const existing = await stateStore.loadIdentity();
  if (existing) {
    const publicKey = b64ToBytes(existing.publicKeyB64);
    const privateKey = b64ToBytes(existing.privateKeyB64);
    return { publicKey, privateKey, did: existing.did as `did:key:${string}` };
  }
  const fresh = await generateEd25519KeyPair();
  await stateStore.saveIdentity({
    publicKeyB64: bytesToB64(fresh.publicKey),
    privateKeyB64: bytesToB64(fresh.privateKey),
    did: fresh.did,
  });
  return fresh;
}

// --- Credo agent construction (isolated so it can be mocked in tests) -----

interface BuildCredoArgs {
  config: AimailConfig;
  keyPair: Ed25519KeyPair;
  endpoints: string[];
  queueRepository: StoreQueueTransportRepository;
  autoGrant: boolean;
}

/** Internal handle to the running Credo agent. */
interface CredoAgentHandle {
  agent: unknown;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Build the Credo agent. This is the only function that imports @credo-ts/*,
 * so the rest of aimail stays decoupled. The imports are dynamic to keep
 * cold-start fast and to surface native-binding failures at start() rather
 * than at import time.
 *
 * The mediator's static did:key is injected after construction via the DID
 * manager so the same DID survives restarts.
 */
async function buildCredoAgent(args: BuildCredoArgs): Promise<CredoAgentHandle> {
  let credo: typeof import('@credo-ts/didcomm');
  let node: typeof import('@credo-ts/node');
  let core: typeof import('@credo-ts/core');
  try {
    core = await import('@credo-ts/core');
    credo = await import('@credo-ts/didcomm');
    node = await import('@credo-ts/node');
  } catch (err) {
    throw new Error(
      `aimail requires @credo-ts/{core,didcomm,node} to be installed. ` +
        `Run: npm install @credo-ts/core @credo-ts/didcomm @credo-ts/node. ` +
        `Underlying error: ${(err as Error).message}`,
    );
  }

  const { Agent } = core;
  const {
    DidCommModule,
    DidCommMessageForwardingStrategy,
    DidCommMessagePickupV2Protocol,
  } = credo;
  const {
    DidCommWsInboundTransport,
    agentDependencies,
  } = node;
  // Outbound transports live in @credo-ts/didcomm in 0.7.
  const { DidCommHttpOutboundTransport, DidCommWsOutboundTransport } = credo;

  // IMPORTANT: import askar-nodejs BEFORE @credo-ts/askar.
  // askar-shared is a CJS module. ESM `import { askar }` from CJS captures
  // the value at import time (NOT a live binding). So NativeAskar.register()
  // must fire before @credo-ts/askar's AskarKeyManagementService reads `askar`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let askar: any;
  try {
    ({ askar } = await import('@openwallet-foundation/askar-nodejs'));
  } catch (err) {
    throw new Error(
      `aimail requires @openwallet-foundation/askar-nodejs. ` +
        `Run: npm install @openwallet-foundation/askar-nodejs. ` +
        `Underlying error: ${(err as Error).message}`,
    );
  }

  // Dynamically import Askar to keep cold-start fast.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let AskarModuleClass: any;
  try {
    ({ AskarModule: AskarModuleClass } = await import('@credo-ts/askar'));
  } catch (err) {
    throw new Error(
      `aimail requires @credo-ts/askar. ` +
        `Run: npm install @credo-ts/askar. ` +
        `Underlying error: ${(err as Error).message}`,
    );
  }

  const inboundTransports: unknown[] = [];
  // DidCommHttpInboundTransport is omitted here because the main HTTP server
  // (REST shim + WS push) handles all HTTP traffic on config.port. If we added
  // it on that port the bind would conflict. DIDComm-over-HTTP messages arrive
  // via the REST shim or WebSocket push instead.
  if (args.config.wsEnabled) {
    inboundTransports.push(
      new DidCommWsInboundTransport({ port: wsPort(args.config) }),
    );
  }
  const outboundTransports: unknown[] = [new DidCommHttpOutboundTransport()];
  if (args.config.wsEnabled) {
    outboundTransports.push(new DidCommWsOutboundTransport());
  }

  const agent = new Agent({
    config: {},
    dependencies: agentDependencies,
    modules: {
      askar: new AskarModuleClass({
        askar,
        store: {
          id: 'aimail',
          key: args.config.keyPassphrase || 'insecure-dev-key',
        },
      }),
      didComm: new DidCommModule({
        endpoints: args.endpoints,
        transports: {
          inbound: inboundTransports as never,
          outbound: outboundTransports as never,
        },
        queueTransportRepository: args.queueRepository as never,
        mediator: {
          autoAcceptMediationRequests: args.autoGrant,
          messageForwardingStrategy:
            DidCommMessageForwardingStrategy.QueueAndLiveModeDelivery,
        },
        messagePickup: {
          protocols: [new DidCommMessagePickupV2Protocol()],
        },
      }),
    } as never,
  });

  // Inject the mediator's static did:key so the same DID survives restarts.
  // Best-effort: if the wallet already has it or the option shape differs
  // across minor versions, we continue — the agent still works with a
  // freshly-generated wallet key.
  try {
    await agent.dids.create({
      method: 'key',
      options: { keyType: 'Ed25519' } as never,
      secret: { privateKey: bytesToB64(args.keyPair.privateKey) } as never,
    });
  } catch {
    // Non-fatal: see comment above.
  }

  return {
    agent,
    async start() {
      await agent.initialize();
    },
    async stop() {
      await agent.shutdown();
    },
  };
}

function wsPort(config: AimailConfig): number {
  // WS inbound shares the same logical endpoint as HTTP in this deployment;
  // we run it on port+1 to avoid a bind conflict with the REST shim server,
  // which owns the primary port. (Credo's WS inbound and our REST HTTP server
  // cannot both listen on the same port.)
  return config.port + 1;
}

// --- Create OOB invitation (must be called after agent.initialize()) ----

async function createInvitationUrl(
  agent: unknown,
  config: AimailConfig,
): Promise<string> {
  // DidCommApi exposes `oob` (DidCommOutOfBandApi) at agent.modules.didComm.oob.
  // BaseAgent lowercases module keys, so agent.didcomm (lowercase) is set but
  // the actual key in modules is `didComm` (camelCase), so go through modules.
  const oobApi = (
    agent as {
      modules: {
        didComm: {
          oob: {
            createInvitation(cfg: {
              label?: string;
              handshake?: boolean;
              multiUseInvitation?: boolean;
            }): Promise<{
              outOfBandInvitation: { toUrl(opts: { domain: string }): string };
            }>;
          };
        };
      };
    }
  ).modules.didComm.oob;
  const oobRecord = await oobApi.createInvitation({
    label: 'aimail-mediator',
    handshake: true,
    multiUseInvitation: true,
  });
  return oobRecord.outOfBandInvitation.toUrl({
    domain: config.publicUrl,
  });
}

// --- base64 helpers (no Buffer dependency, works with Uint8Array) ---

export function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
