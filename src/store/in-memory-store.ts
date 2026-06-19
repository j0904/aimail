// In-memory MessageStore — mirrors ../market's InMemoryMessageStore for the
// market-compatible subset, plus ack/pendingFor for mediator queue semantics.
// Used in dev and tests where Postgres is unavailable.

import type { AgentMessage, MessageStore } from './message-store.js';

export class InMemoryMessageStore implements MessageStore {
  private messages: AgentMessage[] = [];
  private acked = new Set<string>();

  async send(msg: AgentMessage): Promise<void> {
    this.messages.push(msg);
  }

  async inbox(did: string): Promise<AgentMessage[]> {
    return this.messages
      .filter((m) => m.recipientDid === did)
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  async conversation(didA: string, didB: string): Promise<AgentMessage[]> {
    return this.messages
      .filter(
        (m) =>
          (m.senderDid === didA && m.recipientDid === didB) ||
          (m.senderDid === didB && m.recipientDid === didA),
      )
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  async delete(id: string): Promise<void> {
    this.messages = this.messages.filter((m) => m.id !== id);
    this.acked.delete(id);
  }

  async ack(id: string): Promise<boolean> {
    if (!this.messages.some((m) => m.id === id)) return false;
    return this.acked.add(id).has(id);
  }

  async pendingFor(did: string): Promise<AgentMessage[]> {
    return this.messages
      .filter((m) => m.recipientDid === did && !this.acked.has(m.id))
      .sort((a, b) => a.timestamp - b.timestamp);
  }
}
