# aimail User Guide

A practical guide to deploying, operating, and integrating with the aimail DIDComm v2 mediator and mailbox.

---

## Table of Contents

- [Overview](#overview)
- [Installation](#installation)
- [Configuration](#configuration)
- [Running aimail](#running-aimail)
- [CLI Reference](#cli-reference)
- [API Reference](#api-reference)
- [WebSocket Integration](#websocket-integration)
- [DIDComm Integration](#didcomm-integration)
- [Message Lifecycle](#message-lifecycle)
- [Security](#security)
- [Docker Deployment](#docker-deployment)
- [Production Checklist](#production-checklist)
- [Troubleshooting](#troubleshooting)

---

## Overview

aimail is a store-and-forward relay for DIDComm v2 agent-to-agent messaging. It serves as a **mediator** — a well-known relay endpoint that agents discover through DID documents.

Key concepts:

- **DID** (Decentralized Identifier) — a cryptographic identifier like `did:key:z6Mk...`. Each agent has one. DID documents contain service endpoints that point at the mediator.
- **Mediator** — a routing service that accepts double-wrapped messages, reads only the outer envelope to learn the recipient DID, then forwards the inner (E2E-encrypted) payload.
- **Store-and-forward** — messages queue in PostgreSQL when the recipient is offline and are delivered when they reconnect.
- **WebSocket push** — online recipients receive messages immediately over WebSocket. Pending queue is flushed on reconnect.
- **Pickup 2.0** — the DIDComm protocol for offline message retrieval. Recipients pull queued messages via `delivery-request`.
- **Coordinate-Mediation 2.0** — the DIDComm protocol for registering with a mediator.

---

## Installation

### Prerequisites

- **Node.js** ≥22 (ESM)
- **PostgreSQL** 16+ (optional in dev mode)
- **npm** (ships with Node.js)

### Setup

```bash
git clone <repo-url> aimail
cd aimail
npm install
npm run build
```

Optional — run tests to verify:

```bash
npm test
```

---

## Configuration

aimail is configured through environment variables. Copy `.env.example` to `.env` and edit.

### Core settings

| Variable | Default | Description |
|---|---|---|
| `AIMAIL_PORT` | `3080` | HTTP port for REST API and DIDComm inbound |
| `AIMAIL_PUBLIC_URL` | `http://localhost:3080` | Public URL advertised in the mediator's DID document. Change to your domain in production. |
| `AIMAIL_WS_ENABLED` | `true` | Enable WebSocket push transport |
| `AIMAIL_DEV` | — | Set to `1` to use in-memory stores (no Postgres needed; **all data lost on restart**) |

### DID settings

| Variable | Default | Description |
|---|---|---|
| `AIMAIL_DID_METHOD` | `key` | DID method. `key` is self-contained, no hosting needed. `web` requires serving `/.well-known/did.json` (Phase 2). |

### PostgreSQL settings

| Variable | Default | Description |
|---|---|---|
| `PGHOST` | `localhost` | Postgres host |
| `PGPORT` | `5432` | Postgres port |
| `PGUSER` | `marketplace` | Postgres user |
| `PGPASSWORD` | `marketplace` | Postgres password |
| `PGDATABASE` | `marketplace` | Postgres database |
| `AIMAIL_PG_SCHEMA` | `public` | Database schema for aimail tables |

### Security settings

| Variable | Default | Description |
|---|---|---|
| `AIMAIL_KEY_PASSPHRASE` | — | Passphrase for AES-256-GCM at-rest encryption of the mediator's key material. **Must set in production.** |
| `AIMAIL_AUTO_GRANT_MEDIATION` | `true` | Auto-grant incoming `mediate-request` messages. Set to `false` to require an allow-list (Phase 2). |

---

## Running aimail

### Dev mode (in-memory, no Postgres)

```bash
AIMAIL_DEV=1 npm run serve
```

Data is ephemeral — everything resets on restart. Good for testing and development.

### Production mode (Postgres)

```bash
# Ensure Postgres is running and .env is configured
npm run serve
```

Or use the compiled binary directly:

```bash
node dist/cli/aimail.js serve
```

### What happens at startup

1. Config is loaded from environment variables.
2. The database migrates (creates `aimail_messages` and `aimail_mediator_identity` tables if needed).
3. The mediator DID is loaded from the database, or a fresh `did:key` keypair is generated and encrypted-at-rest.
4. The Credo DIDComm agent initializes with the mediator role.
5. An Out-of-Band (OOB) invitation URL is created for agent discovery.
6. The HTTP server starts on `AIMAIL_PORT`.
7. WebSocket push attaches to the same server at `/ws`.

On startup, the console prints:

```
[aimail] mediator ready
[aimail]   DID:           did:key:z6Mk...
[aimail]   endpoints:     http://localhost:3080, ws://localhost:3080
[aimail]   invitation:    https://localhost:3080?oob=...
[aimail]   REST + WS:     http port 3080 (ws /ws)
```

---

## CLI Reference

```bash
aimail <command>
```

### `aimail serve`

Start the mediator server. This is the default command (running `aimail` with no arguments is equivalent).

### `aimail did:create`

Generate a fresh Ed25519 `did:key` keypair and print it as JSON to stdout:

```json
{
  "did": "did:key:z6Mk...",
  "publicKeyBase64": "...",
  "privateKeyBase64": "..."
}
```

Use this to create test identities or bootstrap agent keys for integration testing.

### `aimail --help`

Show help text.

---

## API Reference

### Market-compatible endpoints

These endpoints have identical request/response shapes to the [`market`](https://github.com/anomalyco/market) project, enabling drop-in replacement.

#### POST /api/messages

Send a message.

**Request body:**

```json
{
  "schema": "negotiation/proposal",
  "senderDid": "did:key:z6Mk...",
  "recipientDid": "did:key:z6Mk...",
  "ciphertext": "<base64-encoded E2E-encrypted payload>",
  "nonce": "<optional uuid, generated if omitted>",
  "replyTo": "<optional message ID this replies to>"
}
```

**Response** `201`:

```json
{ "id": "uuid", "sent": true }
```

**Errors:** `400` if `senderDid`, `recipientDid`, or `ciphertext` are missing.

#### GET /api/messages/inbox/:did

List all messages for a recipient DID, newest first.

**Response** `200`:

```json
{
  "messages": [
    { "id": "...", "schema": "...", "senderDid": "did:key:...", "recipientDid": "did:key:...", "ciphertext": "...", "nonce": "...", "timestamp": 1234567890, "replyTo": "..." }
  ],
  "total": 1
}
```

#### GET /api/messages/conversation/:didA/:didB

List all messages exchanged between two DIDs, oldest first.

**Response** `200`:

```json
{ "messages": [...], "total": 1 }
```

#### DELETE /api/messages/:id

Delete a message by ID.

**Response** `200`:

```json
{ "id": "uuid", "deleted": true }
```

---

### Aimail-native endpoints

These extend beyond the market API for mediator-specific operations.

#### GET /api/messages/pending/:did

List un-acknowledged (pending) messages for a recipient DID, oldest first. Used for the Pickup 2.0 pull view.

**Response** `200`:

```json
{ "messages": [...], "total": 1 }
```

#### POST /api/messages/:id/ack

Acknowledge receipt of a message. Marks the message as `acked=true` so it won't be redelivered in future pending queries. The message remains accessible via `inbox` for history.

**Response** `200`:

```json
{ "id": "uuid", "acked": true }
```

**Response** `404`:

```json
{ "error": "message not found or already acked" }
```

#### GET /api/mediator

Get mediator discovery information.

**Response** `200`:

```json
{
  "did": "did:key:z6Mk...",
  "endpoints": ["http://localhost:3080", "ws://localhost:3080"],
  "invitationUrl": "https://localhost:3080?oob=..."
}
```

Agents use the `invitationUrl` to connect via DIDComm Out-of-Band protocol.

#### GET /api/health

Health check.

**Response** `200`:

```json
{
  "status": "ok",
  "mediatorDid": "did:key:z6Mk...",
  "uptime": 3600
}
```

---

## WebSocket Integration

The WebSocket endpoint at `ws://<host>/ws` provides live message push for online agents.

### Connecting

```javascript
const ws = new WebSocket('ws://localhost:3080/ws', {
  headers: {
    'Authorization': 'Bearer did:key:z6Mk...',
  },
});
```

Authentication uses the `Authorization: Bearer <did>` header. In dev mode, the DID string is accepted directly. In production, you can supply an `authenticate` hook to `WsPushManager` to verify a self-signed JWT.

### Receiving messages

Each incoming WebSocket message is a JSON frame:

```json
{
  "type": "message",
  "message": {
    "id": "uuid",
    "schema": "negotiation/proposal",
    "senderDid": "did:key:...",
    "recipientDid": "did:key:...",
    "ciphertext": "...",
    "nonce": "...",
    "timestamp": 1234567890
  }
}
```

### Delivery semantics

1. **Online agent:** when a message arrives for a connected DID, it is pushed immediately over WebSocket and also persisted in the store.
2. **Offline agent:** messages are queued in PostgreSQL with `acked=false`.
3. **Reconnect:** when an agent reconnects, all pending messages are flushed (pushed) to the new socket.
4. **Acknowledgment:** the agent should call `POST /api/messages/:id/ack` after processing (or use DIDComm Pickup 2.0's `messages-received`), which prevents redelivery. Without ack, messages will be redelivered on every reconnect.

---

## DIDComm Integration

aimail implements two DIDComm v2 protocols as a mediator:

### Coordinate-Mediation 2.0

Used by agents to register with the mediator.

1. Agent sends a `mediate-request` DIDComm message to the mediator.
2. Mediator auto-grants (when `AIMAIL_AUTO_GRANT_MEDIATION=true`) and returns a `routing_did`.
3. Agent updates its DID document's `serviceEndpoint` to point at the mediator's URL.
4. Messages addressed to the agent are now routed through aimail.

### Pickup 2.0

Used by agents to retrieve messages that arrived while offline.

1. Agent sends `delivery-request` to the mediator.
2. Mediator responds with `message-delivery` containing queued envelopes.
3. Agent processes each message.
4. Agent sends `messages-received` (message IDs) to ack delivery.

This flow is handled transparently by Credo-TS on the mediator side and by any conformant DIDComm agent on the recipient side.

### Finding the mediator

Agents discover the mediator in two ways:

1. **OOB Invitation** — from the `GET /api/mediator` endpoint's `invitationUrl` field.
2. **DIDComm discovery** — via DID resolution, when the mediator's DID document advertises the `serviceEndpoint`.

---

## Message Lifecycle

```
Sender                     aimail                         Recipient
  |                           |                               |
  |  1. POST /api/messages    |                               |
  |-------------------------->|                               |
  |                           |  2a. Push via WS (online)     |
  |                           |------------------------------>|
  |                           |                               |
  |                           |  2b. Queue in Postgres        |
  |                           |      (offline)                |
  |                           |                               |
  |                           |  3. Reconnect + flush         |
  |                           |<------------------------------|
  |                           |------------------------------>|
  |                           |                               |
  |                           |  4. POST /api/messages/:id/ack|
  |                           |<------------------------------|
  |                           |                               |
  |                           |  5. Mark acked=true           |
```

**Step-by-step:**

1. **Send** — sender POSTs a double-wrapped message. Outer envelope routes to the mediator; inner envelope is E2E-encrypted to the recipient.
2. **Route** — mediator opens the outer envelope, learns the recipient DID, and either pushes live (WS) or queues (Postgres).
3. **Retrieve** — recipient either receives live push, or on reconnect triggers a flush of pending messages.
4. **Acknowledge** — recipient calls ack to prevent redelivery. Messages remain in inbox for history.
5. **Delete** — recipient may delete messages when they are no longer needed.

---

## Security

### End-to-End Encryption

aimail never sees plaintext message content. The sender constructs two nested envelopes:

- **Inner envelope** (JWE): encrypted to the recipient's public key using X25519 ECDH + AES-GCM. Only the recipient can decrypt.
- **Outer envelope** (DIDComm Forward message): addressed to the mediator, contains routing info and the inner envelope as opaque ciphertext.

The mediator unwraps only the outer envelope to extract the routing DID.

### Authenticity

Every DIDComm message is signed by the sender's Ed25519 key. Recipients verify signatures against the sender's DID document, ensuring messages haven't been tampered with.

### At-Rest Encryption

The mediator's own DID private key seed is stored in PostgreSQL as `enc:v1:<base64>`, encrypted with AES-256-GCM. The encryption key is derived from `AIMAIL_KEY_PASSPHRASE` via HKDF-SHA256.

### Replay Protection

Each message carries a unique `nonce`. The store uses `ON CONFLICT (id) DO NOTHING`, so duplicate sends are idempotent.

### Production Security Recommendations

1. **Set a strong `AIMAIL_KEY_PASSPHRASE`** — this protects the mediator's identity at rest.
2. **Use TLS** — place behind a reverse proxy (nginx, Caddy) that terminates HTTPS and WSS.
3. **Restrict database access** — use a dedicated Postgres user with permissions limited to the aimail schema.
4. **Validate WebSocket auth** — implement the `authenticate` hook on `WsPushManager` to verify JWTs.
5. **Run as non-root** — the Docker image runs as `appuser` by default.

---

## Docker Deployment

### Quick start

```bash
docker compose up
```

This starts:
- `postgres` — PostgreSQL 16 on port 5432
- `aimail` — the mediator on port 3080

### Multi-stage build

```bash
# Production image (minimal, runs as non-root)
docker build --target production -t aimail .

# Test image (includes test suite + docker CLI for e2e)
docker build --target test -t aimail:test .
```

### E2E tests in Docker

```bash
docker compose --profile e2e run --rm aimail-e2e
```

### Environment variables for Docker

Override via `docker-compose.yml` environment section or a `.env` file:

```yaml
environment:
  AIMAIL_PORT: 3080
  AIMAIL_PUBLIC_URL: https://aimail.example.com
  AIMAIL_KEY_PASSPHRASE: ${AIMAIL_KEY_PASSPHRASE}
  PGHOST: postgres
  PGUSER: aimail
  PGPASSWORD: ${PGPASSWORD}
  PGDATABASE: aimail
```

---

## Production Checklist

- [ ] Set `AIMAIL_PUBLIC_URL` to the public HTTPS URL.
- [ ] Set `AIMAIL_KEY_PASSPHRASE` to a strong, unique passphrase.
- [ ] Set Postgres credentials via `PGUSER`/`PGPASSWORD` (not the defaults).
- [ ] Place behind a TLS-terminating reverse proxy (nginx, Caddy, Cloudflare Tunnel).
- [ ] Configure monitoring on `GET /api/health`.
- [ ] Test message delivery with both online (WS) and offline (Pickup 2.0) recipients.
- [ ] Verify at-rest encryption: inspect `aimail_mediator_identity` table — the `seed` column should start with `enc:v1:`.
- [ ] Run e2e tests against the deployed stack.

---

## Troubleshooting

### "Askar native binding not found"

The Credo DIDComm agent requires the native Askar library (`@openwallet-foundation/askar-nodejs`). This is installed transitively by `@credo-ts/node` but may fail to build on some platforms.

**Solutions:**
- Use the Docker image (Askar is pre-built in the production stage).
- Ensure your system has build tools: `apt install build-essential python3`.
- On Alpine, you may need additional packages. The Dockerfile handles this.

### WebSocket connection fails with 401

The `Authorization: Bearer <did>` header is missing or the DID is malformed.

**Check:**
- The header must be exactly `Authorization: Bearer did:key:z6Mk...`.
- In dev mode, the DID must match `/^did:/`.

### Messages are not delivered after reconnect

Agents must ack messages after processing (`POST /api/messages/:id/ack` or DIDComm `messages-received`). Without ack, messages remain pending and are redelivered, but only on subsequent reconnects.

### "Port already in use"

The default port 3080 may be taken. Change it with `AIMAIL_PORT`.

The DIDComm WebSocket inbound transport also binds to `AIMAIL_PORT + 1` (default 3081). If that port is in use, the Credo agent will fail to start.

### Database connection refused

Ensure PostgreSQL is running and reachable. In Docker Compose, the `aimail` service waits for the `postgres` service via depends_on but does not implement a readiness probe — give it a few seconds.

### Data loss on restart

If `AIMAIL_DEV=1` is set, all data is in memory and will be lost. Run without `AIMAIL_DEV` and with valid Postgres credentials for persistence.

---

## Architecture Reference

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

### Component roles

| Component | File | Role |
|---|---|---|
| REST shim | `src/compat/market-shim.ts` | Routes HTTP requests to store operations. Market-compatible endpoints match the `market` project shapes exactly. |
| WebSocket push | `src/transport/ws-push.ts` | Manages recipient-DID → socket map. Pushes messages live to connected agents. Flushes pending queue on reconnect. |
| Credo mediator | `src/mediator.ts` | Wraps a Credo-TS agent in mediator role. Handles DIDComm protocols (Coordinate-Mediation 2.0, Pickup 2.0), OOB invitations, and forwarding. |
| MessageStore | `src/store/message-store.ts` | Interface defining the store-and-forward contract. |
| InMemoryStore | `src/store/in-memory-store.ts` | Dev-only implementation. Data lost on restart. |
| PgStore | `src/store/pg-store.ts` | Production implementation. Durable Postgres queue with indexes for inbox, pending, and conversation queries. |
| Credo-Pickup bridge | `src/store/credo-pickup-bridge.ts` | Adapts MessageStore to Credo's `DidCommQueueTransportRepository` interface so Pickup 2.0 shares the same Postgres store. |
| At-rest encryption | `src/store/pg-state-store.ts` | AES-256-GCM encryption of mediator secrets. Key derived via HKDF-SHA256 from `AIMAIL_KEY_PASSPHRASE`. |
| Server | `src/server.ts` | Creates the HTTP server, attaches WebSocket push and REST routing. |
| Config | `src/config.ts` | Loads all environment variables with safe defaults. |
| Identity | `src/identity/keypair.ts` | Ed25519 key generation, `did:key` encoding/decoding. |

---

## Integrating with aimail

### From a JavaScript/TypeScript agent

```typescript
import { InMemoryMessageStore, type AgentMessage } from 'aimail';

const store = new InMemoryMessageStore();

// Send a message
await store.send({
  id: crypto.randomUUID(),
  schema: 'negotiation/proposal',
  senderDid: 'did:key:sender...',
  recipientDid: 'did:key:recipient...',
  ciphertext: '<e2e-encrypted-payload>',
  nonce: crypto.randomUUID(),
  timestamp: Date.now(),
});

// Check inbox
const inbox = await store.inbox('did:key:recipient...');

// Check pending (un-acked)
const pending = await store.pendingFor('did:key:recipient...');

// Acknowledge
await store.ack(messageId);
```

### From the market project

Set `AIMAIL_URL` in the market's config to point at the aimail server. The market uses the same `POST /api/messages`, `GET /api/messages/inbox/:did`, and `GET /api/messages/conversation/:didA/:didB` endpoints with identical request/response shapes.

### From a Go agent (e.g., PicoClaw)

Use the REST API directly:

```go
resp, err := http.Post(
    "http://aimail:3080/api/messages",
    "application/json",
    strings.NewReader(`{
        "schema": "negotiation/proposal",
        "senderDid": "did:key:sender...",
        "recipientDid": "did:key:recipient...",
        "ciphertext": "..."
    }`),
)
```

Or connect via WebSocket for live push:

```go
import "github.com/gorilla/websocket"

c, _, err := websocket.DefaultDialer.Dial(
    "ws://aimail:3080/ws",
    http.Header{"Authorization": {"Bearer did:key:..."}},
)
```

---

## Project layout

```
src/
├─ config.ts                 # Environment-driven config loader
├─ mediator.ts               # Credo agent in mediator role
├─ server.ts                 # HTTP server + WS + REST routing
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
