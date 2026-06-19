// Unit tests for the In-memory and pickup-bridge queue semantics.
// (PgMessageStore is exercised against real Postgres in integration tests.)
import { describe, it, expect } from 'vitest';
import { InMemoryMessageStore } from '../../src/store/in-memory-store.js';
import { StoreQueueTransportRepository } from '../../src/store/credo-pickup-bridge.js';
import type { AgentMessage } from '../../src/store/message-store.js';

function msg(partial: Partial<AgentMessage> & { id: string }): AgentMessage {
  return {
    id: partial.id,
    schema: partial.schema ?? 'negotiation/proposal',
    senderDid: partial.senderDid ?? 'did:key:sender',
    recipientDid: partial.recipientDid ?? 'did:key:recipient',
    ciphertext: partial.ciphertext ?? 'opaque',
    nonce: partial.nonce ?? partial.id,
    timestamp: partial.timestamp ?? Date.now(),
    replyTo: partial.replyTo,
  };
}

describe('InMemoryMessageStore (market-compatible subset)', () => {
  it('send → inbox returns newest first', async () => {
    const store = new InMemoryMessageStore();
    await store.send(msg({ id: '1', timestamp: 100 }));
    await store.send(msg({ id: '2', timestamp: 200 }));
    const inbox = await store.inbox('did:key:recipient');
    expect(inbox.map((m) => m.id)).toEqual(['2', '1']);
  });

  it('conversation returns both directions oldest first', async () => {
    const store = new InMemoryMessageStore();
    await store.send(msg({ id: 'a', senderDid: 'did:key:A', recipientDid: 'did:key:B', timestamp: 100 }));
    await store.send(msg({ id: 'b', senderDid: 'did:key:B', recipientDid: 'did:key:A', timestamp: 200 }));
    const conv = await store.conversation('did:key:A', 'did:key:B');
    expect(conv.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('delete removes a message', async () => {
    const store = new InMemoryMessageStore();
    await store.send(msg({ id: 'x' }));
    await store.delete('x');
    expect(await store.inbox('did:key:recipient')).toEqual([]);
  });

  it('replyTo is optional and round-trips', async () => {
    const store = new InMemoryMessageStore();
    await store.send(msg({ id: 'r', replyTo: 'parent' }));
    const inbox = await store.inbox('did:key:recipient');
    expect(inbox[0].replyTo).toBe('parent');
  });
});

describe('Pickup queue semantics (ack / pendingFor)', () => {
  it('messages are pending until acked', async () => {
    const store = new InMemoryMessageStore();
    await store.send(msg({ id: 'p1' }));
    await store.send(msg({ id: 'p2' }));

    const pending = await store.pendingFor('did:key:recipient');
    expect(pending.map((m) => m.id)).toEqual(['p1', 'p2']); // oldest first

    const acked = await store.ack('p1');
    expect(acked).toBe(true);

    const remaining = await store.pendingFor('did:key:recipient');
    expect(remaining.map((m) => m.id)).toEqual(['p2']);
  });

  it('ack on unknown id returns false', async () => {
    const store = new InMemoryMessageStore();
    expect(await store.ack('nope')).toBe(false);
  });

  it('inbox still shows acked messages (inbox != pending)', async () => {
    const store = new InMemoryMessageStore();
    await store.send(msg({ id: 'k' }));
    await store.ack('k');
    // inbox is "history" — still present until deleted.
    expect((await store.inbox('did:key:recipient')).map((m) => m.id)).toEqual(['k']);
    // but no longer pending.
    expect(await store.pendingFor('did:key:recipient')).toEqual([]);
  });
});

describe('StoreQueueTransportRepository bridge (Credo queue repo)', () => {
  // Credo passes an AgentContext as the first arg; our bridge only uses it for
  // identity, so a stub object is sufficient for unit testing.
  const ctx = { contextCorrelationId: 'test' };

  it('addMessage → takeFromQueue returns stored envelopes', async () => {
    const store = new InMemoryMessageStore();
    const repo = new StoreQueueTransportRepository(
      store,
      'did:key:mediator',
      () => 'gen-1',
    );

    const id = await repo.addMessage(ctx, {
      connectionId: 'conn-1',
      recipientDids: ['did:key:agent'],
      payload: { protected: 'header', ciphertext: 'ENVELOPE-1' },
    });
    expect(id).toBe('gen-1');

    const count = await repo.getAvailableMessageCount(ctx, {
      connectionId: 'conn-1',
      recipientDid: 'did:key:agent',
    });
    expect(count).toBe(1);

    const taken = await repo.takeFromQueue(ctx, {
      connectionId: 'conn-1',
      recipientDid: 'did:key:agent',
      limit: 10,
    });
    expect(taken).toHaveLength(1);
    expect(taken[0].encryptedMessage).toMatchObject({ ciphertext: 'ENVELOPE-1' });
    expect(taken[0].id).toBe('gen-1');
  });

  it('takeFromQueue with deleteMessages acks the messages', async () => {
    const store = new InMemoryMessageStore();
    const repo = new StoreQueueTransportRepository(
      store,
      'did:key:mediator',
      () => 'gen-2',
    );
    await repo.addMessage(ctx, {
      connectionId: 'conn-1',
      recipientDids: ['did:key:agent'],
      payload: { ciphertext: 'E' },
    });

    await repo.takeFromQueue(ctx, {
      connectionId: 'conn-1',
      recipientDid: 'did:key:agent',
      deleteMessages: true,
    });
    expect(
      await repo.getAvailableMessageCount(ctx, {
        connectionId: 'conn-1',
        recipientDid: 'did:key:agent',
      }),
    ).toBe(0);
  });

  it('removeMessages acks by id', async () => {
    const store = new InMemoryMessageStore();
    let n = 0;
    const repo = new StoreQueueTransportRepository(
      store,
      'did:key:mediator',
      () => `id-${n++}`,
    );
    const id = await repo.addMessage(ctx, {
      connectionId: 'conn-1',
      recipientDids: ['did:key:agent'],
      payload: { ciphertext: 'E' },
    });
    await repo.removeMessages(ctx, { connectionId: 'conn-1', messageIds: [id] });
    expect(
      await repo.getAvailableMessageCount(ctx, {
        connectionId: 'conn-1',
        recipientDid: 'did:key:agent',
      }),
    ).toBe(0);
  });

  it('isolates messages by connectionId', async () => {
    const store = new InMemoryMessageStore();
    const repo = new StoreQueueTransportRepository(
      store,
      'did:key:mediator',
      () => 'x',
    );
    await repo.addMessage(ctx, {
      connectionId: 'conn-A',
      recipientDids: ['did:key:agent'],
      payload: { ciphertext: 'A' },
    });
    await repo.addMessage(ctx, {
      connectionId: 'conn-B',
      recipientDids: ['did:key:agent'],
      payload: { ciphertext: 'B' },
    });
    expect(
      await repo.getAvailableMessageCount(ctx, {
        connectionId: 'conn-A',
        recipientDid: 'did:key:agent',
      }),
    ).toBe(1);
    expect(
      await repo.getAvailableMessageCount(ctx, {
        connectionId: 'conn-B',
        recipientDid: 'did:key:agent',
      }),
    ).toBe(1);
  });
});
