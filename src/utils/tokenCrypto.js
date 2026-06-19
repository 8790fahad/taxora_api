const crypto = require('crypto');
const config = require('../config');

// AES-256-GCM encryption for sensitive values (e.g. OAuth tokens) stored at rest.
//
// The 32-byte key is derived from a configured secret via scrypt with a fixed
// salt, so any-length secret works. For production set a dedicated
// TOKEN_ENCRYPTION_KEY (32+ random chars) and keep it in a secret manager /
// key vault — NOT in source control.

const ALGO = 'aes-256-gcm';
const PREFIX = 'enc:v1';
const SALT = 'taxora.token.v1';

let cachedKey = null;

function getKey() {
  if (cachedKey) return cachedKey;
  const secret = config.tokenEncryptionKey || config.jwtSecret;
  if (!secret) {
    throw new Error('No encryption secret configured (TOKEN_ENCRYPTION_KEY or JWT_SECRET).');
  }
  cachedKey = crypto.scryptSync(secret, SALT, 32);
  return cachedKey;
}

// Encrypt a UTF-8 string. Output: "enc:v1:<iv b64>:<tag b64>:<ciphertext b64>".
function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(String(plaintext), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}:${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString(
    'base64'
  )}`;
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(`${PREFIX}:`);
}

// Decrypt a value produced by encrypt(). Returns the original plaintext string.
function decrypt(payload) {
  if (!isEncrypted(payload)) {
    throw new Error('Value is not in the expected encrypted format.');
  }
  const [, , ivB64, tagB64, dataB64] = payload.split(':');
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');
  const decipher = crypto.createDecipheriv(ALGO, getKey(), iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
  return plaintext.toString('utf8');
}

// Convenience helpers for JSON values.
function encryptJson(obj) {
  return encrypt(JSON.stringify(obj));
}

function decryptJson(payload) {
  return JSON.parse(decrypt(payload));
}

module.exports = { encrypt, decrypt, encryptJson, decryptJson, isEncrypted };
