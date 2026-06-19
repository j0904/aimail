// Postgres-backed MessageStore.
//
// Stores DID-addressed, E2E-opaque messages in a durable queue. Mirrors the
// table conventions of ../market/src/infrastructure/postgres (idempotent
// CREATE TABLE IF NOT EXISTS, snake_case columns, pg.Pool). Shares the market's
// database by default so a single Postgres backs both services.
//
// Queue semantics:
//   - `send`      enqueues (inserts with acked=false).
//   - `inbox`     returns all messages for a recipient, newest first.
//   - `pendingFor` returns un-acked messages, oldest first (Pickup 2.0 pull).
//   - `ack`       marks acked=true so the message is not redelivered.
//   - `delete`    hard-deletes a row.

import pg from 'pg';
import type { AgentMessage, MessageStore } from './message-store.js';

export interface PgStoreOptions {
  schema?: string;
}

const DEFAULT_SCHEMA = 'public';

export class PgMessageStore implements MessageStore {
  private readonly schema: string;
  private migrated = false;

  constructor(private pool: pg.Pool, opts: PgStoreOptions = {}) {
    this.schema = opts.schema ?? DEFAULT_SCHEMA;
  }

  /** Idempotent schema setup. Call once at boot before any other method. */
  async migrate(): Promise<void> {
    if (this.migrated) return;
    const client = await this.pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.schema}.aimail_messages (
          id            TEXT PRIMARY KEY,
          schema        TEXT NOT NULL,
          sender_did    TEXT NOT NULL,
          recipient_did TEXT NOT NULL,
          ciphertext    TEXT NOT NULL,
          nonce         TEXT NOT NULL,
          timestamp     BIGINT NOT NULL,
          reply_to      TEXT,
          acked         BOOLEAN NOT NULL DEFAULT false,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_aimail_messages_recipient
          ON ${this.schema}.aimail_messages(recipient_did);
        CREATE INDEX IF NOT EXISTS idx_aimail_messages_recipient_pending
          ON ${this.schema}.aimail_messages(recipient_did, acked, timestamp);
        CREATE INDEX IF NOT EXISTS idx_aimail_messages_pair
          ON ${this.schema}.aimail_messages(sender_did, recipient_did);
      `);
    } finally {
      client.release();
    }
    this.migrated = true;
  }

  async send(msg: AgentMessage): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.schema}.aimail_messages
         (id, schema, sender_did, recipient_did, ciphertext, nonce, timestamp, reply_to)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO NOTHING`,
      [
        msg.id,
        msg.schema,
        msg.senderDid,
        msg.recipientDid,
        msg.ciphertext,
        msg.nonce,
        msg.timestamp,
        msg.replyTo ?? null,
      ],
    );
  }

  async inbox(did: string): Promise<AgentMessage[]> {
    const result = await this.pool.query<AgentMessage & Record<string, unknown>>(
      `SELECT id, schema, sender_did AS "senderDid", recipient_did AS "recipientDid",
              ciphertext, nonce, timestamp, reply_to AS "replyTo"
       FROM ${this.schema}.aimail_messages
       WHERE recipient_did = $1
       ORDER BY timestamp DESC`,
      [did],
    );
    return result.rows.map(rowFromDb);
  }

  async conversation(didA: string, didB: string): Promise<AgentMessage[]> {
    const result = await this.pool.query<AgentMessage & Record<string, unknown>>(
      `SELECT id, schema, sender_did AS "senderDid", recipient_did AS "recipientDid",
              ciphertext, nonce, timestamp, reply_to AS "replyTo"
       FROM ${this.schema}.aimail_messages
       WHERE (sender_did = $1 AND recipient_did = $2)
          OR (sender_did = $2 AND recipient_did = $1)
       ORDER BY timestamp ASC`,
      [didA, didB],
    );
    return result.rows.map(rowFromDb);
  }

  async delete(id: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM ${this.schema}.aimail_messages WHERE id = $1`,
      [id],
    );
  }

  async ack(id: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ${this.schema}.aimail_messages SET acked = true WHERE id = $1`,
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async pendingFor(did: string): Promise<AgentMessage[]> {
    const result = await this.pool.query<AgentMessage & Record<string, unknown>>(
      `SELECT id, schema, sender_did AS "senderDid", recipient_did AS "recipientDid",
              ciphertext, nonce, timestamp, reply_to AS "replyTo"
       FROM ${this.schema}.aimail_messages
       WHERE recipient_did = $1 AND acked = false
       ORDER BY timestamp ASC`,
      [did],
    );
    return result.rows.map(rowFromDb);
  }
}

function rowFromDb(row: AgentMessage & Record<string, unknown>): AgentMessage {
  // replyTo may be null; drop it to match the optional field contract.
  const m: AgentMessage = {
    id: String(row.id),
    schema: String(row.schema),
    senderDid: String(row.senderDid),
    recipientDid: String(row.recipientDid),
    ciphertext: String(row.ciphertext),
    nonce: String(row.nonce),
    timestamp: Number(row.timestamp),
  };
  if (row.replyTo !== null && row.replyTo !== undefined) {
    m.replyTo = String(row.replyTo);
  }
  return m;
}
