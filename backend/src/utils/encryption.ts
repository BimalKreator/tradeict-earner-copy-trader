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

/**
 * Strip every non printable-ASCII char (anything outside `\x21..\x7E`) and
 * surrounding whitespace. This guarantees the resulting string is safe to
 * embed in HTTP headers (Node `http` rejects bytes < 0x20 and >= 0x80 in
 * header values, hence the `Invalid character in header content` errors).
 */
function hardSanitizeKey(s: string): string {
  return s.replace(/[^\x21-\x7E]+/g, "").trim();
}

/** Minimum length for a Delta API key / secret after sanitization. */
const MIN_CREDENTIAL_LEN = 8;

function isUsableCredential(s: string): boolean {
  return s.length >= MIN_CREDENTIAL_LEN && /^[\x21-\x7E]+$/.test(s);
}

function isCryptoJsAesCiphertext(stored: string): boolean {
  return stored.trim().startsWith("U2Fsd");
}

/**
 * Decrypt stored Delta credentials, or return sanitized plaintext (legacy rows).
 *
 * Must stay aligned with {@link decryptDeltaSecret} used by "Test connection" —
 * if AES decrypt succeeds, the sanitized plaintext is returned even when the
 * secret contains punctuation outside `[A-Za-z0-9_\-+/=:.]` (e.g. `!@#%`).
 */
export function decryptDeltaSecretOrPlain(stored: string): string {
  if (!stored) return "";
  const trimmed = stored.trim();

  let decryptFailed = false;
  let decrypted = "";
  try {
    decrypted = hardSanitizeKey(decryptDeltaSecret(trimmed));
  } catch {
    decryptFailed = true;
    decrypted = "";
  }

  if (isUsableCredential(decrypted)) {
    return decrypted;
  }

  const plainLegacy = hardSanitizeKey(trimmed);
  if (isUsableCredential(plainLegacy) && !isCryptoJsAesCiphertext(trimmed)) {
    return plainLegacy;
  }

  if (isCryptoJsAesCiphertext(trimmed) && decryptFailed) {
    console.error(
      "[encryption] Delta credential is AES-encrypted but decryption failed — " +
        "verify PROCESS_ENCRYPTION_KEY matches the key used when the API key was saved",
    );
  }

  return "";
}

/** Mask a stored key for admin UI (never return full secrets in JSON). */
export function maskDeltaApiKey(stored: string): string {
  const plain = decryptDeltaSecretOrPlain(stored);
  if (!plain) return "";
  if (plain.length <= 8) return "••••••••";
  return `${plain.slice(0, 6)}••••${plain.slice(-4)}`;
}

/**
 * Normalize credentials for DB storage — always AES-encrypt canonical plaintext.
 * Accepts either legacy plaintext rows or existing ciphertext.
 */
export function normalizeStoredDeltaSecret(plaintextOrStored: string): string {
  const trimmed = plaintextOrStored.trim();
  if (!trimmed) return "";
  const plain = decryptDeltaSecretOrPlain(trimmed);
  if (!plain) {
    throw new Error(
      "Could not read API credential — re-paste from Delta Exchange India without extra spaces.",
    );
  }
  return encryptDeltaSecret(plain);
}
