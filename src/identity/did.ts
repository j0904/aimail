// DID identity types — kept identical to ../market/src/types/identity.ts so that
// every agent has one DID across the agent, market, and aimail ecosystems.

export type DID = `did:${string}:${string}`;

export type DIDMethod = 'key' | 'web' | 'plc' | (string & {});

export function makeDID(method: DIDMethod, identifier: string): DID {
  return `did:${method}:${identifier}` as DID;
}

/**
 * Parse a DID string into its method and identifier components.
 * Returns null for malformed input (anything not matching `did:method:id`).
 */
export function parseDID(did: string): { method: string; id: string } | null {
  // did:method:identifier — method is the second segment, identifier is the rest.
  const match = /^did:([^:]+):(.+)$/.exec(did);
  if (!match) return null;
  return { method: match[1], id: match[2] };
}

/** Type guard for the DID template-literal type. */
export function isDID(value: string): value is DID {
  return /^did:[^:]+:.+$/.test(value);
}
