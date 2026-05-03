import CryptoJS from "crypto-js";
function getEncryptionKey() {
    const key = process.env.PROCESS_ENCRYPTION_KEY;
    if (!key || !key.trim()) {
        throw new Error("PROCESS_ENCRYPTION_KEY is required for Delta API key encryption");
    }
    return key;
}
/**
 * Encrypt a Delta API key / secret (or any UTF-8 string) using AES.
 */
export function encryptDeltaSecret(plaintext) {
    const key = getEncryptionKey();
    return CryptoJS.AES.encrypt(plaintext, key).toString();
}
/**
 * Decrypt ciphertext produced by {@link encryptDeltaSecret}.
 */
export function decryptDeltaSecret(ciphertext) {
    const key = getEncryptionKey();
    const bytes = CryptoJS.AES.decrypt(ciphertext, key);
    const plain = bytes.toString(CryptoJS.enc.Utf8);
    if (!plain) {
        throw new Error("Decryption failed: wrong PROCESS_ENCRYPTION_KEY or corrupted payload");
    }
    return plain;
}
/** Decrypt stored Delta credentials, or return trimmed plaintext (legacy rows). */
export function decryptDeltaSecretOrPlain(stored) {
    const t = stored.trim();
    if (!t)
        return t;
    try {
        return decryptDeltaSecret(stored);
    }
    catch {
        return t;
    }
}
//# sourceMappingURL=encryption.js.map