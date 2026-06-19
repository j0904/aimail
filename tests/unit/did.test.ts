// Unit tests for DID + Ed25519 / did:key encoding (pure crypto, no Credo).
import { describe, it, expect } from 'vitest';
import {
  parseDID,
  isDID,
  makeDID,
} from '../../src/identity/did.js';
import {
  generateEd25519KeyPair,
  publicKeyToDidKey,
  didKeyToPublicKey,
  base58btcEncode,
  base58btcDecode,
} from '../../src/identity/keypair.js';

describe('DID helpers', () => {
  it('makeDID composes a did string', () => {
    expect(makeDID('key', 'abc')).toBe('did:key:abc');
    expect(makeDID('web', 'example.com')).toBe('did:web:example.com');
  });

  it('parseDID splits method and id', () => {
    expect(parseDID('did:key:z6Mkfoo')).toEqual({ method: 'key', id: 'z6Mkfoo' });
    expect(parseDID('did:web:example.com:user')).toEqual({
      method: 'web',
      id: 'example.com:user',
    });
    expect(parseDID('not-a-did')).toBeNull();
    expect(parseDID('did:')).toBeNull();
  });

  it('isDID narrows the template type', () => {
    expect(isDID('did:key:z6Mkfoo')).toBe(true);
    expect(isDID('did:web:example.com')).toBe(true);
    expect(isDID('http://x')).toBe(false);
    expect(isDID('did:')).toBe(false);
  });
});

describe('base58btc round-trip', () => {
  it('encodes and decodes arbitrary bytes', () => {
    for (const len of [0, 1, 2, 32, 33, 34]) {
      const input = new Uint8Array(len);
      for (let i = 0; i < len; i++) input[i] = (i * 7 + 3) % 256;
      const encoded = base58btcEncode(input);
      const decoded = base58btcDecode(encoded);
      expect(Array.from(decoded)).toEqual(Array.from(input));
    }
  });

  it('encodes leading zero bytes as leading 1s', () => {
    const input = new Uint8Array([0, 0, 42]);
    expect(base58btcEncode(input)).toBe('11' + base58btcEncode(new Uint8Array([42])));
  });
});

describe('did:key Ed25519 encoding', () => {
  it('round-trips a generated keypair', async () => {
    const kp = await generateEd25519KeyPair();
    expect(kp.publicKey.length).toBe(32);
    expect(kp.privateKey.length).toBe(32);
    expect(kp.did).toMatch(/^did:key:z/);

    const recovered = didKeyToPublicKey(kp.did);
    expect(Array.from(recovered)).toEqual(Array.from(kp.publicKey));
  });

  it('publicKeyToDidKey rejects non-32-byte keys', () => {
    expect(() => publicKeyToDidKey(new Uint8Array(31))).toThrow(/32 bytes/);
  });

  it('didKeyToPublicKey rejects non-Ed25519 or malformed did:keys', () => {
    expect(() => didKeyToPublicKey('did:web:example.com')).toThrow(/did:key/);
    expect(() => didKeyToPublicKey('did:key:not-multibase')).toThrow(/did:key/);
  });

  it('produces a stable, spec-shaped did:key for a known key', () => {
    // Fixed 32-byte key → deterministic did:key (regression guard).
    const pub = new Uint8Array(32);
    for (let i = 0; i < 32; i++) pub[i] = i + 1;
    const did = publicKeyToDidKey(pub);
    // Must be multibase 'z' + base58 of 0xed01 + pubkey.
    const decoded = base58btcDecode(did.slice('did:key:z'.length));
    expect(decoded[0]).toBe(0xed);
    expect(decoded[1]).toBe(0x01);
    expect(decoded.length).toBe(34);
  });
});
