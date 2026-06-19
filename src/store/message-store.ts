// aimail MessageStore — superset of ../market's MessageStore interface.
//
// The shape of an AgentMessage is identical to ../market/src/agent-message/index.ts
// so aimail can be swapped in for the market's InMemoryMessageStore with no
// client-side changes. We add `ack` and `pending` for the mediator's
// store-and-forward queue (Pickup 2.0 message-received clears from the queue).

import type { DID } from '../identity/did.js';

/** Message schema union — mirrors ../market's MessageSchema for compatibility. */
export type MessageSchema =
  | 'negotiation/proposal'
  | 'negotiation/counter'
  | 'negotiation/accept'
  | 'negotiation/reject'
  | 'negotiation/conditional-accept'
  | 'negotiation/walkaway'
  | 'negotiation/info-request'
  | 'contract/draft'
  | 'contract/amend-request'
  // aimail-native schemas (forward-compat: unknown schemas are stored verbatim).
  | (string & {});

/**
 * An E2E-encrypted agent-to-agent message. The mediator stores `ciphertext`
 * opaque — it never inspects the payload. This shape matches
 * ../market/src/agent-message/index.ts exactly.
 */
export interface AgentMessage {
  id: string;
  schema: MessageSchema;
  senderDid: string;
  recipientDid: string;
  ciphertext: string; // E2E encrypted payload (opaque to the mediator)
  nonce: string; // for replay protection
  timestamp: number;
  replyTo?: string; // message ID this replies to
}

/**
 * Store-and-forward mailbox contract. The first four methods mirror the
 * market's MessageStore exactly so aimail is a drop-in replacement; `ack`
 * and `pendingFor` extend it for Pickup 2.0 queue semantics.
 */
export interface MessageStore {
  /** Enqueue a message for the recipient. */
  send(msg: AgentMessage): Promise<void>;
  /** All queued messages for a recipient DID, newest first. */
  inbox(did: string): Promise<AgentMessage[]>;
  /** The full conversation between two DIDs, oldest first. */
  conversation(didA: string, didB: string): Promise<AgentMessage[]>;
  /** Remove a specific message by id (clears it from the queue). */
  delete(id: string): Promise<void>;

  // --- Mediator queue extensions (Pickup 2.0) ---

  /**
   * Acknowledge receipt of a message by id. The mediator clears it from the
   * recipient's pending queue so it is not redelivered. Returns true if a
   * message was cleared.
   */
  ack(id: string): Promise<boolean>;
  /**
   * Messages still pending delivery/ack for a recipient DID, oldest first.
   * Used by the Pickup 2.0 delivery-request flow.
   */
  pendingFor(did: string): Promise<AgentMessage[]>;
}

/** Convenience type alias used by callers that only need the market-compatible subset. */
export type MarketMessageStore = Pick<
  MessageStore,
  'send' | 'inbox' | 'conversation' | 'delete'
>;

/** Type guard for a plausible AgentMessage. */
export function isAgentMessage(v: unknown): v is AgentMessage {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m.id === 'string' &&
    typeof m.schema === 'string' &&
    typeof m.senderDid === 'string' &&
    typeof m.recipientDid === 'string' &&
    typeof m.ciphertext === 'string' &&
    typeof m.nonce === 'string' &&
    typeof m.timestamp === 'number'
  );
}

/** Re-export DID for consumers importing from this module. */
export type { DID };
