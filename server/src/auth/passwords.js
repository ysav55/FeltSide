import bcrypt from 'bcryptjs';

const ROUNDS = 10;
export const MIN_PASSWORD_LENGTH = 8;

export function hashPassword(plain) {
  return bcrypt.hash(plain, ROUNDS);
}

export function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

export function validNewPassword(plain) {
  return typeof plain === 'string' && plain.length >= MIN_PASSWORD_LENGTH;
}
