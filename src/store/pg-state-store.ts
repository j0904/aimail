// At-rest encryption helper for mediator secrets.
//
// Mirrors the AES-256-GCM scheme used by ../agent's pkg/credential: a key is
// derived from a passphrase via HKDF-SHA256, then used to wrap short secrets
// (here, the mediator's Ed25519 seed). Stored format: 'enc:v1:' + base64(iv||ciphertext||tag).
//
// When AIMAIL_KEY_PASSPHRASE is empty (dev only), we fall back to a fixed
// throwaway key. Production MUST set the passphrase.

import { webcrypto } from 'node:crypto';

const subtle = webcrypto.subtle;

const VERSION = 'v1';
const PREFIX = `enc:${VERSION}:`;
const INFO = 'aimail-mediator-v1';

/** Derive a 256-bit AES-GCM key from a passphrase via HKDF-SHA256. */
async function deriveKey(passphrase: string): Promise<CryptoKey> {
  const ikm = await subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase || 'aimail-dev-throwaway-key'),
    'HKDF',
    false,
    ['deriveKey'],
  );
  return subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(INFO),
    },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Encrypt a UTF-8 string. Returns 'enc:v1:<base64(iv||ciphertext||tag)>'. */
export async function encryptSecret(plain: string, passphrase: string): Promise<string> {
  const key = await deriveKey(passphrase);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(plain),
    ),
  );
  // AES-GCM appends the 16-byte tag to the ciphertext.
  const combined = new Uint8Array(iv.length + ct.length);
  combined.set(iv, 0);
  combined.set(ct, iv.length);
  return PREFIX + bytesToB64(combined);
}

/** Decrypt a value produced by encryptSecret. Throws on tamper / wrong key. */
export async function decryptSecret(blob: string, passphrase: string): Promise<string> {
  if (!blob.startsWith(PREFIX)) throw new Error('not an aimail enc secret');
  const key = await deriveKey(passphrase);
  const combined = b64ToBytes(blob.slice(PREFIX.length));
  const iv = combined.slice(0, 12);
  const ct = combined.slice(12);
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new TextDecoder().decode(pt);
}

// --- base64 helpers (shared with mediator.ts; duplicated to avoid a cycle) ---
function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
