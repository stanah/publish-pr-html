import test from 'node:test';
import assert from 'node:assert/strict';
import { INLINE_LIMIT_BYTES, buildDispatchPayload, chooseTransport, payloadByteLength } from '../src/lib/transport.mjs';

const sha = 'b'.repeat(40);
const uuid = '11111111-2222-4333-8444-555555555555';
const req = { ref: 'main', prNumber: 5, headSha: sha, requestId: uuid, htmlSha256: 'c'.repeat(64) };

function overheadFor(html) {
  return payloadByteLength(buildDispatchPayload({ ...req, transport: 'inline', html }));
}

test('decision is made on JSON payload bytes, not file size', () => {
  const overhead = overheadFor('');
  // ASCII: one byte per char inside JSON.
  const fitting = 'a'.repeat(INLINE_LIMIT_BYTES - overhead);
  assert.equal(chooseTransport({ ...req, html: fitting }).transport, 'inline');
  assert.equal(chooseTransport({ ...req, html: fitting }).bytes, INLINE_LIMIT_BYTES);
  assert.equal(chooseTransport({ ...req, html: fitting + 'a' }).transport, 'release');
});

test('multibyte and escaped characters count as JSON bytes', () => {
  const overhead = overheadFor('');
  // "あ" is 3 bytes in UTF-8 and is not escaped by JSON.stringify.
  const jp = 'あ'.repeat(Math.floor((INLINE_LIMIT_BYTES - overhead) / 3));
  assert.equal(chooseTransport({ ...req, html: jp }).transport, 'inline');
  assert.equal(chooseTransport({ ...req, html: jp + 'あ' }).transport, 'release');
  // A quote is 1 byte on disk but 2 bytes in JSON.
  const quotes = '"'.repeat(Math.floor((INLINE_LIMIT_BYTES - overhead) / 2));
  assert.equal(chooseTransport({ ...req, html: quotes }).transport, 'inline');
  assert.equal(chooseTransport({ ...req, html: quotes + '"' }).transport, 'release');
});

test('payload preserves CRLF and shell syntax verbatim', () => {
  const html = '<p>$(echo hi) `x` \\ "q"</p>\r\n<p>日本語</p>';
  const payload = buildDispatchPayload({ ...req, transport: 'inline', html });
  assert.equal(JSON.parse(JSON.stringify(payload)).inputs.html, html);
  assert.equal(payload.inputs.asset_id, undefined);
});

test('release payload carries only asset_id', () => {
  const payload = buildDispatchPayload({ ...req, transport: 'release', assetId: 42 });
  assert.deepEqual(payload.inputs, { pr_number: '5', head_sha: sha, request_id: uuid, html_sha256: 'c'.repeat(64), transport: 'release', asset_id: '42' });
});
