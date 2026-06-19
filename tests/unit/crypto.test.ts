// Unit tests for at-rest secret encryption (AES-256-GCM via HKDF).
import { describe, it, expect } from 'vitest';
import { encryptSecret, decryptSecret } from '../../src/store/pg-state-store.js';

describe('at-rest secret encryption', () => {
  it('round-trips a base64 secret under a passphrase', async () => {
    const secret = 'c29tZS1lZDI1NTE5LXNlZWQ='; // arbitrary base64
    const blob = await encryptSecret(secret, 'correct horse battery staple');
    expect(blob.startsWith('enc:v1:')).toBe(true);
    expect(blob).not.toContain(secret);
    const back = await decryptSecret(blob, 'correct horse battery staple');
    expect(back).toBe(secret);
  });

  it('rejects decryption under the wrong passphrase', async () => {
    const blob = await encryptSecret('data', 'right');
    await expect(decryptSecret(blob, 'wrong')).rejects.toThrow();
  });

  it('falls back to a dev key when passphrase is empty (both sides)', async () => {
    const blob = await encryptSecret('data', '');
    const back = await decryptSecret(blob, '');
    expect(back).toBe('data');
  });

  it('detects tampering (authenticity)', async () => {
    const blob = await encryptSecret('data', 'pw');
    // Flip one character in the ciphertext region.
    const tampered = blob.slice(0, -2) + (blob.slice(-2) === 'AA' ? 'BB' : 'AA');
    await expect(decryptSecret(tampered, 'pw')).rejects.toThrow();
  });

  it('throws on a non-aimail blob', async () => {
    await expect(decryptSecret('not-encrypted', 'pw')).rejects.toThrow(/enc secret/);
  });
});
