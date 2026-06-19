// Bridge from aimail's DID-keyed MessageStore to Credo's
// DidCommQueueTransportRepository interface.
//
// Credo's MediatorModule queues Forward-message envelopes via a queue transport
// repository keyed by (connectionId, recipientDid). We adapt that onto our own
// MessageStore (which is DID-keyed) so the mediator queue, the Pickup 2.0 flow,
// and the market-compatible REST shim all share one durable Postgres store.
//
// Mapping: each queued envelope becomes an AgentMessage row where
//   recipientDid  = the routed recipient DID (the routing key)
//   ciphertext    = the opaque encrypted envelope (JSON-serialized)
//   nonce         = '<connectionId>'  (we stash the connectionId here so
//                   takeFromQueue/removeMessages can filter by it; the nonce
//                   is otherwise unused for raw envelopes)
//   schema        = ENVELOPE_SCHEMA
//   senderDid     = the mediator's own DID
//
// We JSON-serialize the envelope because DidCommEncryptedMessage is a JSON
// object (a JWE), and our AgentMessage.ciphertext is a string column. This is
// lossless and keeps the market-compatible shape intact.

import type { AgentMessage, MessageStore } from './message-store.js';

/** Schema tag marking a row as a raw DIDComm envelope (vs a market message). */
export const ENVELOPE_SCHEMA = 'didcomm/envelope';

/**
 * Minimal shape of the Credo `AgentContext` we rely on. We avoid importing the
 * real type so this module stays decoupled and unit-testable without Credo
 * installed. Credo passes its full AgentContext; we only read its identity.
 */
export interface CredoAgentContextLike {
  contextCorrelationId?: string;
}

/** Credo's DidCommEncryptedMessage is a JSON object (a JWE envelope). */
export type DidCommEncryptedMessage = Record<string, unknown>;

/** A queued envelope as Credo's queue repo exchanges it. */
export interface QueuedDidCommMessage {
  id: string;
  receivedAt: Date;
  encryptedMessage: DidCommEncryptedMessage;
}

export interface GetAvailableMessageCountOptions {
  connectionId: string;
  recipientDid?: string;
}
export interface TakeFromQueueOptions {
  connectionId: string;
  recipientDid?: string;
  limit?: number;
  deleteMessages?: boolean;
}
export interface AddMessageOptions {
  connectionId: string;
  recipientDids: string[];
  payload: DidCommEncryptedMessage;
  receivedAt?: Date;
}
export interface RemoveMessagesOptions {
  connectionId: string;
  messageIds: string[];
}

/**
 * Adapts a MessageStore into a Credo DidCommQueueTransportRepository.
 *
 * NOTE: Credo keys the queue by connectionId. A single recipient DID may have
 * multiple connections (and vice versa, after rotation). We index by recipient
 * DID and record the connectionId in the nonce, so getAvailableMessageCount /
 * takeFromQueue / removeMessages can all filter by either. This is correct for
 * the mediator use-case where one routed DID = one active mediation.
 */
export class StoreQueueTransportRepository {
  constructor(
    private store: MessageStore,
    private mediatorDid: string,
    private idFactory: () => string,
  ) {}

  async addMessage(
    _agentContext: CredoAgentContextLike,
    options: AddMessageOptions,
  ): Promise<string> {
    // Credo allows multiple recipientDids per add; we store one row per DID so
    // each routed key can be picked up independently.
    const id = this.idFactory();
    const recipientDid = options.recipientDids[0] ?? '';
    const msg: AgentMessage = {
      id,
      schema: ENVELOPE_SCHEMA,
      senderDid: this.mediatorDid,
      recipientDid,
      ciphertext: JSON.stringify(options.payload),
      nonce: options.connectionId,
      timestamp: (options.receivedAt ?? new Date()).getTime(),
    };
    await this.store.send(msg);
    return id;
  }

  async getAvailableMessageCount(
    _agentContext: CredoAgentContextLike,
    options: GetAvailableMessageCountOptions,
  ): Promise<number> {
    const did = options.recipientDid ?? '';
    if (!did) return 0;
    const pending = await this.store.pendingFor(did);
    return pending.filter((m) => m.nonce === options.connectionId).length;
  }

  async takeFromQueue(
    _agentContext: CredoAgentContextLike,
    options: TakeFromQueueOptions,
  ): Promise<QueuedDidCommMessage[]> {
    const did = options.recipientDid ?? '';
    if (!did) return [];
    const pending = await this.store.pendingFor(did);
    const filtered = pending.filter((m) => m.nonce === options.connectionId);
    const slice = filtered.slice(0, options.limit ?? filtered.length);
    if (options.deleteMessages) {
      await Promise.all(slice.map((m) => this.store.ack(m.id)));
    }
    return slice.map((m) => ({
      id: m.id,
      receivedAt: new Date(m.timestamp),
      encryptedMessage: parseEnvelope(m.ciphertext),
    }));
  }

  async removeMessages(
    _agentContext: CredoAgentContextLike,
    options: RemoveMessagesOptions,
  ): Promise<void> {
    await Promise.all(options.messageIds.map((id) => this.store.ack(id)));
  }
}

function parseEnvelope(ciphertext: string): DidCommEncryptedMessage {
  try {
    return JSON.parse(ciphertext) as DidCommEncryptedMessage;
  } catch {
    // Not JSON (e.g. a market-style opaque string); wrap so delivery still works.
    return { raw: ciphertext };
  }
}
