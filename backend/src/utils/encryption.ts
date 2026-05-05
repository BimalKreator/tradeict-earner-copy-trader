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

/**
 * Decrypted strings that are not real API keys (e.g. produced by a wrong
 * `PROCESS_ENCRYPTION_KEY` causing CryptoJS to emit garbage UTF-8) tend to
 * contain bytes outside the alphanumeric / common-symbol set used by Delta
 * keys. Treat anything that is not an ASCII alphanumeric / `-_+/=:` token
 * as suspicious and refuse to use it as a credential.
 */
function looksLikeApiCredential(s: string): boolean {
  if (s.length < 8) return false;
  return /^[A-Za-z0-9_\-+/=:.]+$/.test(s);
}

/**
 * Decrypt stored Delta credentials, or return sanitized plaintext (legacy rows).
 *
 * Hardening:
 *   - Strips every non printable-ASCII byte from both candidate values so
 *     the resulting string is guaranteed valid in HTTP headers.
 *   - If decryption produces output that does not look like an API key (e.g.
 *     because PROCESS_ENCRYPTION_KEY changed between encrypt and decrypt),
 *     we fall back to the sanitized plaintext rather than passing garbage
 *     to CCXT.
 */
export function decryptDeltaSecretOrPlain(stored: string): string {
  if (!stored) return "";
  const plain = hardSanitizeKey(stored);

  let decrypted = "";
  try {
    decrypted = hardSanitizeKey(decryptDeltaSecret(stored));
  } catch {
    decrypted = "";
  }

  if (decrypted && looksLikeApiCredential(decrypted)) return decrypted;
  if (plain && looksLikeApiCredential(plain)) return plain;
  // last-resort: return whichever is non-empty so callers can detect the
  // failure (Delta will reject with `invalid_api_key`, which we surface).
  return decrypted || plain;
}
