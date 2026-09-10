import test from 'node:test';
import assert from 'node:assert/strict';
import { ValidationError, validateDispatchInputs, validateHtmlBytes } from '../src/lib/validate.mjs';
import { sha256Hex } from '../src/lib/hash.mjs';

const sha = 'a'.repeat(40);
const uuid = '11111111-2222-4333-8444-555555555555';
const base = { pr_number: '12', head_sha: sha, request_id: uuid, html_sha256: 'f'.repeat(64) };

test('inline inputs are normalized', () => {
  const r = validateDispatchInputs({ ...base, transport: 'inline', html: '<p>x</p>\r\n', asset_id: '' });
  assert.deepEqual(r, { prNumber: 12, headSha: sha, requestId: uuid, htmlSha256: 'f'.repeat(64), transport: 'inline', html: '<p>x</p>\r\n' });
});

test('release inputs are normalized', () => {
  const r = validateDispatchInputs({ ...base, transport: 'release', asset_id: '456' });
  assert.equal(r.transport, 'release');
  assert.equal(r.assetId, 456);
});

test('both html and asset_id is rejected', () => {
  assert.throws(() => validateDispatchInputs({ ...base, transport: 'inline', html: 'x', asset_id: '1' }), ValidationError);
});

test('missing conditional input is rejected', () => {
  assert.throws(() => validateDispatchInputs({ ...base, transport: 'inline', html: '' }), /requires html/);
  assert.throws(() => validateDispatchInputs({ ...base, transport: 'release', asset_id: '' }), /requires asset_id/);
});

test('malformed identifiers are rejected', () => {
  assert.throws(() => validateDispatchInputs({ ...base, pr_number: '0', transport: 'inline', html: 'x' }), /pr_number/);
  assert.throws(() => validateDispatchInputs({ ...base, head_sha: sha.slice(0, 7), transport: 'inline', html: 'x' }), /head_sha/);
  assert.throws(() => validateDispatchInputs({ ...base, request_id: 'not-a-uuid', transport: 'inline', html: 'x' }), /request_id/);
  assert.throws(() => validateDispatchInputs({ ...base, html_sha256: 'F'.repeat(64), transport: 'inline', html: 'x' }), /html_sha256/);
  assert.throws(() => validateDispatchInputs({ ...base, transport: 'gzip', html: 'x' }), /transport/);
  assert.throws(() => validateDispatchInputs({ ...base, transport: 'release', asset_id: '12abc' }), /asset_id/);
});

test('html bytes: size, utf-8 and digest', () => {
  const html = Buffer.from('<p>こんにちは "quoted" $(rm -rf /) `x`</p>\r\n', 'utf8');
  assert.equal(validateHtmlBytes(html, { expectedSha256: sha256Hex(html) }), sha256Hex(html));
  assert.throws(() => validateHtmlBytes(html, { expectedSha256: '0'.repeat(64) }), /SHA-256 mismatch/);
  assert.throws(() => validateHtmlBytes(html, { maxBytes: html.length - 1 }), /exceeds/);
  assert.throws(() => validateHtmlBytes(Buffer.from([0xff, 0xfe, 0x3c])), /UTF-8/);
  assert.throws(() => validateHtmlBytes(Buffer.alloc(0)), /empty/);
});
