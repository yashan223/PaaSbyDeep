import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const PREFIX = 'enc:v1:';

function getKey() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET must be set to encrypt/decrypt tokens.');
  }
  return crypto.createHash('sha256').update(secret).digest();
}

/**
 * Encrypt a sensitive string (e.g. GitHub PAT) using AES-256-GCM.
 * Returns null if input is empty.
 */
export function encryptSecret(plaintext) {
  if (!plaintext || typeof plaintext !== 'string') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypt an AES-256-GCM encrypted string.
 * Returns null if input is empty or invalid.
 */
export function decryptSecret(ciphertext) {
  if (!ciphertext || typeof ciphertext !== 'string') return null;
  if (!ciphertext.startsWith(PREFIX)) return ciphertext;

  const parts = ciphertext.slice(PREFIX.length).split(':');
  if (parts.length !== 3) return null;

  try {
    const [ivHex, tagHex, dataHex] = parts;
    const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(dataHex, 'hex')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  } catch {
    return null;
  }
}
