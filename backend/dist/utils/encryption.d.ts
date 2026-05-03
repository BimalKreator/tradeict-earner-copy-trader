/**
 * Encrypt a Delta API key / secret (or any UTF-8 string) using AES.
 */
export declare function encryptDeltaSecret(plaintext: string): string;
/**
 * Decrypt ciphertext produced by {@link encryptDeltaSecret}.
 */
export declare function decryptDeltaSecret(ciphertext: string): string;
/** Decrypt stored Delta credentials, or return trimmed plaintext (legacy rows). */
export declare function decryptDeltaSecretOrPlain(stored: string): string;
//# sourceMappingURL=encryption.d.ts.map