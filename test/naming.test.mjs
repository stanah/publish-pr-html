import test from 'node:test';
import assert from 'node:assert/strict';
import { artifactFileName, parseRelayAssetName, relayAssetName, shortSha } from '../src/lib/naming.mjs';

const sha = '0123456789abcdef0123456789abcdef01234567';
const uuid = '11111111-2222-4333-8444-555555555555';

test('relay asset name round-trips', () => {
  const name = relayAssetName({ prNumber: 123, headSha: sha, requestId: uuid });
  assert.equal(name, `pr-html-123-${shortSha(sha)}-${uuid}.html`);
  assert.deepEqual(parseRelayAssetName(name), { prNumber: 123, shortSha: '0123456789ab', requestId: uuid });
});

test('foreign asset names are rejected', () => {
  assert.equal(parseRelayAssetName('release-notes.html'), null);
  assert.equal(parseRelayAssetName(`pr-html-0-${shortSha(sha)}-${uuid}.html`), null);
  assert.equal(parseRelayAssetName(`pr-html-1-${shortSha(sha)}-${uuid}.html.bak`), null);
});

test('artifact file name is unique per run attempt', () => {
  assert.equal(artifactFileName({ prNumber: 7, headSha: sha, runId: 99, runAttempt: 2 }), 'pr-7-0123456789ab-99-2.html');
});
