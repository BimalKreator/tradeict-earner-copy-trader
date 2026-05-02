import CryptoJS from "crypto-js";

function getEncryptionKey(): string {
  const key = process.env.PROCESS_ENCRYPTION_KEY;
  if (!key || !key.trim()) {
    throw new Error("PROCESS_ENCRYPTION_KEY is required for Delta API key encryption");
  }
  return key;
}

/**
 * Encrypt a Delta API key / secret (or any UTF-8 string) using AES.
 */
export function encryptDeltaSecret(plaintext: string): string {
  const key = getEncryptionKey();
  return CryptoJS.AES.encrypt(plaintext, key).toString();
}

/**
 * Decrypt ciphertext produced by {@link encryptDeltaSecret}.
 */
export function decryptDeltaSecret(ciphertext: string): string {
  const key = getEncryptionKey();
  const bytes = CryptoJS.AES.decrypt(ciphertext, key);
  const plain = bytes.toString(CryptoJS.enc.Utf8);
  if (!plain) {
    throw new Error("Decryption failed: wrong PROCESS_ENCRYPTION_KEY or corrupted payload");
  }
  return plain;
}
