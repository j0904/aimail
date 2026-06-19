# aimail

**DIDComm v2 mediator & mailbox** — email for AI agents.  
A store-and-forward relay that queues messages for offline agents and pushes them live over WebSocket when the recipient is online.

Built on [Credo-TS](https://credo.js.org/) with a Postgres-backed message store and a REST API compatible with the [`market`](https://github.com/anomalyco/market) project.

---

## Why

The sibling repos need agent-to-agent messaging but lack it:

- **`market`** has a DID-addressed mailbox but it's polling-only, in-memory, has no E2E crypto, and no push. aimail is a drop-in, durable, push-capable replacement.
- **`agent`** (PicoClaw) has no agent-to-agent transport at all. aimail provides the transport.

aimail is a **mediator** in the DIDComm sense: a dumb pipe that stores and forwards double-wrapped envelopes. It can open only the outer (forward) envelope to learn the routed recipient DID; the inner payload stays E2E encrypted to the recipient's key. Trust stays between agents, not with the mediator.

---

## Quick start

```bash
npm install
npm run build

# Dev mode — in-memory store, no Postgres needed
AIMAIL_DEV=1 npm run serve
```

Open http://localhost:3080/api/health.

---

## Configuration

Copy `.env.example` to `.env` and adjust.

| Variable | Default | Description |
|---|---|---|
| `AIMAIL_PORT` | `3080` | HTTP port |
| `AIMAIL_PUBLIC_URL` | `http://localhost:3080` | Public URL advertised in DID document |
| `AIMAIL_DID_METHOD` | `key` | DID method (`key` or `web`) |
| `AIMAIL_WS_ENABLED` | `true` | Enable WebSocket push |
| `AIMAIL_DEV` | — | Set to `1` for in-memory stores (no Postgres) |
| `PGHOST` | `localhost` | Postgres host |
| `PGPORT` | `5432` | Postgres port |
| `PGUSER` | `marketplace` | Postgres user |
| `PGPASSWORD` | `marketplace` | Postgres password |
| `PGDATABASE` | `marketplace` | Postgres database |
| `AIMAIL_PG_SCHEMA` | `public` | Database schema for aimail tables |
| `AIMAIL_KEY_PASSPHRASE` | — | Passphrase for at-rest encryption. **Must set in production.** |
| `AIMAIL_AUTO_GRANT_MEDIATION` | `true` | Auto-grant `mediate-request` messages |

---

## CLI

```bash
# Start the server (default command)
aimail serve

# Generate a new did:key keypair
aimail did:create
```

---

## API

### Market-compatible endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/messages` | Send a message |
| `GET` | `/api/messages/inbox/:did` | List messages for a recipient, newest first |
| `GET` | `/api/messages/conversation/:didA/:didB` | Conversation between two DIDs, oldest first |
| `DELETE` | `/api/messages/:id` | Delete a message |

### Aimail-native endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/messages/pending/:did` | Un-acked (pending) messages, oldest first |
| `POST` | `/api/messages/:id/ack` | Acknowledge a message (mark delivered) |
| `GET` | `/api/mediator` | Mediator discovery info (DID, endpoints, invitation URL) |
| `GET` | `/api/health` | Health check |

### WebSocket

```
ws://<host>/ws
```

Connect with header `Authorization: Bearer <did>`. Messages are pushed as:

```json
{ "type": "message", "message": { "id": "...", "schema": "...", "senderDid": "did:key:...", "recipientDid": "did:key:...", "ciphertext": "...", "nonce": "...", "timestamp": 1234567890 } }
```

---

## Architecture

```
                          aimail server
  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
  │  REST shim    │  │  WebSocket   │  │  Credo        │
  │ (market API)  │  │  push        │  │  mediator     │
  ├──────────────┤  ├──────────────┤  ├──────────────┤
  │ POST /api/   │  │ /ws endpoint │  │ DIDComm      │
  │ messages     │  │ live push    │  │ messenger    │
  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
         └──────────────────┼─────────────────┘
                            │
                     ┌──────▼──────┐
                     │ MessageStore │
                     │  (interface) │
                     ├──────┬──────┤
                ┌────▼──┐ ┌─▼────────┐
                │ InMem │ │ PgStore  │
                └───────┘ └──────────┘
```

- **REST shim** — exact request/response shapes from `market` for drop-in compatibility
- **WebSocket push** — recipient-DID → socket map, authenticates via `Authorization` header, flushes pending on connect
- **Credo mediator** — DIDComm mediation, Pickup 2.0, OOB invitations, Coordinate-Mediation 2.0
- **MessageStore** — interface with InMemory (dev) and Postgres (prod) implementations
- **At-rest encryption** — mediator private key seed encrypted with AES-256-GCM (HKDF-SHA256 key derivation)

Dependencies: Node.js ≥22, PostgreSQL 16+ (optional in dev mode).

---

## Testing

```bash
# Unit + integration (no Postgres needed)
npm test

# Watch mode
npm run test:watch

# Integration only
npm run test:integration

# E2E — requires Postgres + docker profile
AIMAIL_E2E=1 npm run test:e2e

# Via Docker
docker compose --profile e2e run --rm aimail-e2e
```

---

## Docker

```bash
# aimail + Postgres
docker compose up

# Multi-stage build targets: build, test, production
docker build --target production -t aimail .
```

---

## How a message flows

1. **Recipient registers for mediation** (Coordinate-Mediation 2.0): sends a `mediate-request`; the mediator auto-grants and returns a `routing_did`. The recipient updates its DID document's `serviceEndpoint` to point at aimail.

2. **Sender sends:** looks up the recipient's DID document, finds aimail's endpoint, double-wraps the message (inner = E2E to recipient; outer = to mediator) and POSTs it.

3. **Mediator routes:** opens the outer envelope only enough to learn the routed recipient DID. If the recipient is connected over WS, pushes immediately; otherwise queues in Postgres.

4. **Recipient picks up:** on reconnect, runs Pickup 2.0 (`delivery-request` → `message-delivery`), then sends `messages-received` to ack — which clears the messages from the queue.

The mediator never sees plaintext: the inner envelope is encrypted solely to the recipient's public key (X25519 + AES-GCM via Credo JWE). Every message is signed by the sender's Ed25519 key for authenticity.

---

## Security model

- **E2E encryption:** the inner payload is encrypted only to the recipient's public key. The mediator cannot read message content.
- **Authenticity:** every message is signed by the sender's Ed25519 private key; the recipient verifies against the sender DID's document.
- **At-rest:** the mediator's own DID/seed is persisted in Postgres encrypted with AES-256-GCM (key derived via HKDF-SHA256 from `AIMAIL_KEY_PASSPHRASE`).
- **Mediator is a dumb pipe:** it queues and forwards but cannot read. Trust stays agent-to-agent.

---

## Project layout

```
src/
├─ config.ts                 # env-driven config
├─ mediator.ts               # Credo agent in mediator role (the core)
├─ server.ts                 # HTTP server + WS attach + routing to shim
├─ index.ts                  # Public barrel exports
├─ identity/
│  ├─ did.ts                 # DID type helpers
│  └─ keypair.ts             # Ed25519 key generation + did:key encoding
├─ store/
│  ├─ message-store.ts       # MessageStore interface
│  ├─ in-memory-store.ts     # Dev/test implementation
│  ├─ pg-store.ts            # Postgres-backed queue
│  ├─ credo-pickup-bridge.ts # Adapts MessageStore → Credo queue repo
│  ├─ pg-state-store.ts      # AES-256-GCM at-rest encryption
│  └─ pg-mediator-state.ts   # Persists mediator DID/key (encrypted)
├─ transport/
│  └─ ws-push.ts             # WebSocket push manager
├─ compat/
│  └─ market-shim.ts         # REST API routing
└─ cli/
   └─ aimail.ts              # CLI entry point
tests/
├─ unit/                     # DID, store, crypto tests
├─ integration/              # Market-shim HTTP round-trip tests
└─ e2e/                      # Full-stack tests (needs Postgres)
```

---

## Status

Phase 1 is scaffolded and the non-Credo unit/integration tests pass. Wiring the mediator to a live Credo agent requires the native Askar binding (`@openwallet-foundation/askar-nodejs`, installed transitively via `@credo-ts/node`); the `tests/e2e/` suite exercises that path under docker compose.

Open items: Askar build on Alpine, `did:web` hosting, broadcast semantics (Phase 2).
