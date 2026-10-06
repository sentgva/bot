// Шифрование чувствительных данных (номер карты для ручной выплаты) — AES-256-GCM.
// Ключ DATA_KEY: 64 hex-символа. Сгенерировать: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
// После выплаты или отказа зашифрованный номер удаляется из базы.

import crypto from 'node:crypto';
import { config } from './config.js';

const key = () => {
  const k = Buffer.from(config.dataKey, 'hex');
  if (k.length !== 32) throw new Error('DATA_KEY должен быть 32 байта в hex');
  return k;
};

export const canEncrypt = () => Buffer.from(config.dataKey || '', 'hex').length === 32;

export function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
}

export function decrypt(box) {
  const [iv, tag, data] = String(box).split('.').map((s) => Buffer.from(s, 'base64url'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
