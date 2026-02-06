import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const SALT_LENGTH = 32;
const KEY_LENGTH = 32;

function getKey(encryptionKey) {
  if (!encryptionKey || encryptionKey.length < 64) {
    throw new Error('ENCRYPTION_KEY must be at least 32 bytes (64 hex chars)');
  }
  return Buffer.from(encryptionKey.slice(0, 64), 'hex');
}

export function encrypt(text, encryptionKey) {
  const key = getKey(encryptionKey);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag();
  return iv.toString('hex') + tag.toString('hex') + encrypted;
}

export function decrypt(encrypted, encryptionKey) {
  const key = getKey(encryptionKey);
  const iv = Buffer.from(encrypted.slice(0, IV_LENGTH * 2), 'hex');
  const tag = Buffer.from(encrypted.slice(IV_LENGTH * 2, (IV_LENGTH + TAG_LENGTH) * 2), 'hex');
  const data = encrypted.slice((IV_LENGTH + TAG_LENGTH) * 2);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(data, 'hex', 'utf8') + decipher.final('utf8');
}
