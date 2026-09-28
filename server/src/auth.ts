import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  const actual = scryptSync(password, salt, 32);
  return timingSafeEqual(actual, Buffer.from(hash, 'hex'));
}

export function newToken(): string {
  return randomBytes(24).toString('base64url');
}
