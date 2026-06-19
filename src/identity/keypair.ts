// Ed25519 keypair generation and did:key encoding/decoding.
//
// The mediator mints its own did:key on first boot. We use Node's Web Crypto
// (Ed25519) and encode the public key as a multibase/multicodec did:key per
// the W3C spec, so it resolves with any conformant DID resolver (including
// Credo's DidKeyResolver).
//
// did:key format:
//   did:key:<multibase>
// where multibase = 'z' + base58btc(multicodec-prefix || raw-32-byte-pubkey)
// Ed25519 multicodec prefix = 0xed01

import { webcrypto } from 'node:crypto';

const ED25519_MULTICODEC_PREFIX = new Uint8Array([0xed, 0x01]);

/** Base58 BTC alphabet (matches the multibase 'z' prefix convention). */
const BASE58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58btcEncode(bytes: Uint8Array): string {
  // Leading zero bytes map to leading '1's.
  let int = 0n;
  for (const b of bytes) int = (int << 8n) | BigInt(b);
  let encoded = '';
  const base = 58n;
  while (int > 0n) {
    const rem = int % base;
    int /= base;
    encoded = BASE58_ALPHABET[Number(rem)] + encoded;
  }
  // Leading zero bytes
  let pad = 0;
  for (const b of bytes) {
    if (b === 0) pad++;
    else break;
  }
  return '1'.repeat(pad) + encoded;
}

export function base58btcDecode(str: string): Uint8Array {
  let int = 0n;
  const base = 58n;
  for (const ch of str) {
    const idx = BASE58_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`invalid base58 character: ${ch}`);
    int = int * base + BigInt(idx);
  }
  // Big-endian bytes
  const bytes: number[] = [];
  while (int > 0n) {
    bytes.unshift(Number(int & 0xffn));
    int >>= 8n;
  }
  // Leading '1's -> zero bytes
  let pad = 0;
  for (const ch of str) {
    if (ch === '1') pad++;
    else break;
  }
  return new Uint8Array([...new Array(pad).fill(0), ...bytes]);
}

/** Encode a 32-byte Ed25519 public key as a did:key string. */
export function publicKeyToDidKey(publicKey: Uint8Array): `did:key:${string}` {
  if (publicKey.length !== 32) {
    throw new Error(`Ed25519 public key must be 32 bytes, got ${publicKey.length}`);
  }
  const prefixed = new Uint8Array(ED25519_MULTICODEC_PREFIX.length + publicKey.length);
  prefixed.set(ED25519_MULTICODEC_PREFIX, 0);
  prefixed.set(publicKey, ED25519_MULTICODEC_PREFIX.length);
  return `did:key:z${base58btcEncode(prefixed)}`;
}

/** Extract the 32-byte Ed25519 public key from a did:key string. */
export function didKeyToPublicKey(didKey: string): Uint8Array {
  const match = /^did:key:z(.+)$/.exec(didKey);
  if (!match) throw new Error(`not a multibase did:key: ${didKey}`);
  const decoded = base58btcDecode(match[1]);
  if (
    decoded.length !== 34 ||
    decoded[0] !== 0xed ||
    decoded[1] !== 0x01
  ) {
    throw new Error(`did:key does not encode an Ed25519 key: ${didKey}`);
  }
  return decoded.slice(2);
}

export interface Ed25519KeyPair {
  /** 32-byte Ed25519 public key. */
  publicKey: Uint8Array;
  /** 32-byte Ed25519 private key seed. */
  privateKey: Uint8Array;
  /** The did:key for this public key. */
  did: `did:key:${string}`;
}

/** Generate a fresh Ed25519 keypair and its did:key via Web Crypto. */
export async function generateEd25519KeyPair(): Promise<Ed25519KeyPair> {
  const generated = await webcrypto.subtle.generateKey(
    // { name: 'Ed25519' } with false extractable would return a single CryptoKey,
    // but the union return type forces a narrow. We request sign/verify which for
    // Ed25519 yields a CryptoKeyPair-like; guard with a runtime check.
    { name: 'Ed25519' },
    true,
    ['sign', 'verify'],
  );
  const kp = generated as CryptoKeyPair;
  const pubBytes = new Uint8Array(await webcrypto.subtle.exportKey('raw', kp.publicKey));
  // PKCS8 export, then take the last 32 bytes (the Ed25519 seed).
  const pkcs8 = new Uint8Array(await webcrypto.subtle.exportKey('pkcs8', kp.privateKey));
  // Ed25519 PKCS8 seed sits in the final 32 bytes of the DER structure.
  const seed = pkcs8.slice(pkcs8.length - 32);
  return {
    publicKey: pubBytes,
    privateKey: seed,
    did: publicKeyToDidKey(pubBytes),
  };
}
