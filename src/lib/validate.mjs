import { FULL_SHA_PATTERN, POSITIVE_INT_PATTERN, SHA256_PATTERN, UUID_PATTERN } from './naming.mjs';
import { isValidUtf8, sha256Hex } from './hash.mjs';

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

export const DEFAULT_MAX_HTML_BYTES = 10 * 1024 * 1024; // 10 MiB
export const DEFAULT_RETENTION_DAYS = 30;
export const DEFAULT_RELAY_MAX_AGE_DAYS = 7;

function str(value) {
  return value === undefined || value === null ? '' : String(value);
}

export function validatePrNumber(value) {
  const s = str(value).trim();
  if (!POSITIVE_INT_PATTERN.test(s)) throw new ValidationError(`pr_number must be a positive integer, got "${s}"`);
  return Number(s);
}

export function validateFullSha(value, label = 'head_sha') {
  const s = str(value).trim();
  if (!FULL_SHA_PATTERN.test(s)) throw new ValidationError(`${label} must be a full 40-hex lowercase commit SHA`);
  return s;
}

export function validateRequestId(value) {
  const s = str(value).trim();
  if (!UUID_PATTERN.test(s)) throw new ValidationError('request_id must be a lowercase UUID');
  return s;
}

export function validateSha256(value, label = 'html_sha256') {
  const s = str(value).trim();
  if (!SHA256_PATTERN.test(s)) throw new ValidationError(`${label} must be a 64-hex lowercase SHA-256`);
  return s;
}

export function validateTransport(value) {
  const s = str(value).trim();
  if (s !== 'inline' && s !== 'release') throw new ValidationError(`transport must be "inline" or "release", got "${s}"`);
  return s;
}

export function validatePositiveInt(value, label) {
  const s = str(value).trim();
  if (!POSITIVE_INT_PATTERN.test(s)) throw new ValidationError(`${label} must be a positive integer, got "${s}"`);
  return Number(s);
}

/**
 * Validate the raw workflow_dispatch inputs and return a normalized request.
 * `html` / `asset_id` are conditionally required; specifying both is rejected.
 */
export function validateDispatchInputs(raw) {
  const prNumber = validatePrNumber(raw.pr_number);
  const headSha = validateFullSha(raw.head_sha);
  const requestId = validateRequestId(raw.request_id);
  const htmlSha256 = validateSha256(raw.html_sha256);
  const transport = validateTransport(raw.transport);
  const html = str(raw.html);
  const assetId = str(raw.asset_id).trim();

  if (html !== '' && assetId !== '') throw new ValidationError('html and asset_id must not both be specified');
  if (transport === 'inline') {
    if (html === '') throw new ValidationError('transport=inline requires html');
    return { prNumber, headSha, requestId, htmlSha256, transport, html };
  }
  if (assetId === '') throw new ValidationError('transport=release requires asset_id');
  return { prNumber, headSha, requestId, htmlSha256, transport, assetId: validatePositiveInt(assetId, 'asset_id') };
}

/** Validate size, UTF-8 and digest of the HTML bytes. Returns the digest. */
export function validateHtmlBytes(buffer, { maxBytes = DEFAULT_MAX_HTML_BYTES, expectedSha256 } = {}) {
  if (buffer.length === 0) throw new ValidationError('HTML is empty');
  if (buffer.length > maxBytes) throw new ValidationError(`HTML is ${buffer.length} bytes, exceeds the limit of ${maxBytes} bytes`);
  if (!isValidUtf8(buffer)) throw new ValidationError('HTML is not valid UTF-8');
  const digest = sha256Hex(buffer);
  if (expectedSha256 !== undefined && digest !== expectedSha256) {
    throw new ValidationError(`SHA-256 mismatch: expected ${expectedSha256}, got ${digest}`);
  }
  return digest;
}
