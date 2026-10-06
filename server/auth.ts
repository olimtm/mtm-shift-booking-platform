import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import type { StoredUser } from './db.js';
import type { User } from '../shared/types.js';
import type { Store } from './db.js';
import { isActiveWorker } from '../shared/views.js';
export function hasActiveWorkerAccess(
  store: Store,
  user: Pick<User, 'role' | 'workerId'>,
): boolean {
  if (user.role !== 'worker') return true;
  const worker = user.workerId && store.get('staff', user.workerId);
  return Boolean(worker && isActiveWorker(worker));
}
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`;
}
export function verifyPassword(password: string, hash: string): boolean {
  const [algorithm, salt, encoded] = hash.split('$');
  if (algorithm !== 'scrypt' || !salt || !encoded) return false;
  const expected = Buffer.from(encoded, 'hex');
  const actual = scryptSync(password, salt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
export const publicUser = ({
  passwordHash: _passwordHash,
  disabled: _disabled,
  ...user
}: StoredUser): User => user;
export function isConfiguredSecret(
  secret: string | undefined,
  minimumLength = 32,
): secret is string {
  return Boolean(
    secret &&
    secret.length >= minimumLength &&
    secret.length <= 1024 &&
    !/\s/.test(secret) &&
    !/(not.?sure|change.?me|replace|placeholder|your.?secret|example|password)/i.test(secret) &&
    new Set(secret).size >= 8,
  );
}
