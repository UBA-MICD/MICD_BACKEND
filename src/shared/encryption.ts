import crypto from "crypto";
import { encryptionConfig } from "../config/env";

/**
 * AES-256-GCM encryption for secrets at rest (Zenodo API tokens). The key is
 * read lazily from ENCRYPTION_KEY so a deployment without the Zenodo feature
 * configured still boots — the error surfaces only when encryption is used.
 */
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // recommended nonce size for GCM

function getKey(): Buffer {
  const keyHex = encryptionConfig.keyHex;
  if (!keyHex) {
    throw new Error(
      "ENCRYPTION_KEY no está configurada. Definila en el archivo .env (32 bytes en hex, ver .env.example).",
    );
  }
  const key = Buffer.from(keyHex, "hex");
  if (key.length !== 32) {
    throw new Error("ENCRYPTION_KEY debe representar 32 bytes (64 caracteres hex).");
  }
  return key;
}

export function assertEncryptionKeyConfigured(): void {
  getKey();
}

export function encrypt(plainText: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("hex"), authTag.toString("hex"), encrypted.toString("hex")].join(":");
}

export function decrypt(cipherText: string): string {
  const key = getKey();
  const [ivHex, authTagHex, dataHex] = cipherText.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const encrypted = Buffer.from(dataHex, "hex");

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString("utf8");
}
