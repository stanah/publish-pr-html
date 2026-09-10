import { createHash } from 'node:crypto';

export function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function isValidUtf8(buffer) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}
