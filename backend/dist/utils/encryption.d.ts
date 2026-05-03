/**
 * Encrypt a Delta API key / secret (or any UTF-8 string) using AES.
 */
export declare function encryptDeltaSecret(plaintext: string): string;
/**
 * Decrypt ciphertext produced by {@link encryptDeltaSecret}.
 */
export declare function decryptDeltaSecret(ciphertext: string): string;
//# sourceMappingURL=encryption.d.ts.map