// Postgres-backed MediatorStateStore: persists the mediator's own DID/key
// (at-rest encrypted) so the same identity survives restarts.
//
// Uses a tiny single-row table 'aimail_mediator_identity' in the same Postgres
// as the message queue. Idempotent CREATE TABLE IF NOT EXISTS like ../market.

import pg from 'pg';
import type { MediatorStateStore, SerializedKeyPair } from '../mediator.js';
import { encryptSecret, decryptSecret } from './pg-state-store.js';

const ROW_KEY = 'default';

export class PgMediatorStateStore implements MediatorStateStore {
  private migrated = false;

  constructor(
    private pool: pg.Pool,
    private schema: string,
    private passphrase: string,
  ) {}

  async migrate(): Promise<void> {
    if (this.migrated) return;
    const client = await this.pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.schema}.aimail_mediator_identity (
          key       TEXT PRIMARY KEY,
          did       TEXT NOT NULL,
          public_key_b64  TEXT NOT NULL,
          secret_b64      TEXT NOT NULL,
          updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
    } finally {
      client.release();
    }
    this.migrated = true;
  }

  async loadIdentity(): Promise<SerializedKeyPair | null> {
    const result = await this.pool.query<{
      did: string;
      public_key_b64: string;
      secret_b64: string;
    }>(
      `SELECT did, public_key_b64, secret_b64
       FROM ${this.schema}.aimail_mediator_identity
       WHERE key = $1`,
      [ROW_KEY],
    );
    if (!result.rows[0]) return null;
    const row = result.rows[0];
    const privateKeyB64 = await decryptSecret(row.secret_b64, this.passphrase);
    return {
      did: row.did,
      publicKeyB64: row.public_key_b64,
      privateKeyB64,
    };
  }

  async saveIdentity(kp: SerializedKeyPair): Promise<void> {
    const secretB64 = await encryptSecret(kp.privateKeyB64, this.passphrase);
    await this.pool.query(
      `INSERT INTO ${this.schema}.aimail_mediator_identity
         (key, did, public_key_b64, secret_b64)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (key) DO UPDATE SET
         did = EXCLUDED.did,
         public_key_b64 = EXCLUDED.public_key_b64,
         secret_b64 = EXCLUDED.secret_b64,
         updated_at = NOW()`,
      [ROW_KEY, kp.did, kp.publicKeyB64, secretB64],
    );
  }
}
