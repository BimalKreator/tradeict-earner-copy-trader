import CryptoJS from "crypto-js";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";

/** Prefix for AES-256-GCM payloads (IV + auth tag + ciphertext, base64). */
export const GCM_SECRET_PREFIX = "gcm:v1:";

const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

function getEncryptionKey(): string {
  const key = process.env.PROCESS_ENCRYPTION_KEY;
  if (!key || !key.trim()) {
    throw new Error("PROCESS_ENCRYPTION_KEY is required for Delta API key encryption");
  }
  return key;
}

function deriveGcmKey(): Buffer {
  return scryptSync(getEncryptionKey(), "tradeict-delta-gcm-v1", 32);
}

export function isGcmSecret(stored: string): boolean {
  return stored.trim().startsWith(GCM_SECRET_PREFIX);
}

/**
 * Encrypt using AES-256-GCM with a unique random IV prepended to the ciphertext.
 */
export function encryptSecretGCM(plaintext: string): string {
  const key = deriveGcmKey();
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, tag, encrypted]).toString("base64");
  return `${GCM_SECRET_PREFIX}${payload}`;
}

/**
 * Decrypt ciphertext produced by {@link encryptSecretGCM}.
 */
export function decryptSecretGCM(ciphertext: string): string {
  const trimmed = ciphertext.trim();
  if (!trimmed.startsWith(GCM_SECRET_PREFIX)) {
    throw new Error("Not a GCM ciphertext");
  }
  const raw = Buffer.from(trimmed.slice(GCM_SECRET_PREFIX.length), "base64");
  if (raw.length <= GCM_IV_BYTES + GCM_TAG_BYTES) {
    throw new Error("GCM payload too short");
  }
  const iv = raw.subarray(0, GCM_IV_BYTES);
  const tag = raw.subarray(GCM_IV_BYTES, GCM_IV_BYTES + GCM_TAG_BYTES);
  const encrypted = raw.subarray(GCM_IV_BYTES + GCM_TAG_BYTES);
  const key = deriveGcmKey();
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString("utf8");
  if (!plain) {
    throw new Error("GCM decryption produced empty plaintext");
  }
  return plain;
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
 * Supports GCM (`gcm:v1:`), legacy CryptoJS AES-CBC, and plaintext rows.
 */
export function decryptDeltaSecretOrPlain(stored: string): string {
  if (!stored) return "";
  const trimmed = stored.trim();

  if (isGcmSecret(trimmed)) {
    try {
      const decrypted = hardSanitizeKey(decryptSecretGCM(trimmed));
      if (isUsableCredential(decrypted)) {
        return decrypted;
      }
    } catch (err) {
      console.error(
        "[encryption] GCM credential decryption failed:",
        err instanceof Error ? err.message : err,
      );
    }
    return "";
  }

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
  return encryptSecretGCM(plain);
}
