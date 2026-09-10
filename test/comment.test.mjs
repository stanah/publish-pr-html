import test from 'node:test';
import assert from 'node:assert/strict';
import { GITHUB_ACTIONS_BOT_ID, buildCommentBody, decide, parseMeta, selectPublishComment } from '../src/lib/comment.mjs';
import { COMMENT_MARKER } from '../src/lib/naming.mjs';

const sha = 'd'.repeat(40);
const uuid = '11111111-2222-4333-8444-555555555555';
const meta = { request_id: uuid, head_sha: sha, html_sha256: 'e'.repeat(64), run_number: 12, artifact_id: 99 };

function body(overrides = {}) {
  return buildCommentBody({
    serverUrl: 'https://github.com',
    repo: 'o/r',
    artifactUrl: 'https://github.com/o/r/actions/runs/1/artifacts/99',
    headSha: sha,
    publishedAt: '2026-09-11T00:00:00.000Z',
    retentionDays: 30,
    runUrl: 'https://github.com/o/r/actions/runs/1',
    meta: { ...meta, ...overrides },
  });
}

test('comment body round-trips metadata and shows required fields', () => {
  const b = body();
  assert.ok(b.startsWith(COMMENT_MARKER));
  assert.deepEqual(parseMeta(b), meta);
  assert.match(b, /actions\/runs\/1\/artifacts\/99/);
  assert.match(b, new RegExp(sha.slice(0, 12)));
  assert.match(b, /2026-09-11 00:00:00 UTC/);
  assert.match(b, /30日（2026-10-11 まで）/);
});

test('metadata containing a comment terminator is refused', () => {
  assert.throws(() => body({ evil: '-->' }), /-->/);
});

test('parseMeta ignores unrelated or malformed bodies', () => {
  assert.equal(parseMeta('hello'), null);
  assert.equal(parseMeta(`${COMMENT_MARKER}\n<!-- pr-html-meta {not json -->`), null);
  assert.equal(parseMeta(`${COMMENT_MARKER}\nno meta`), null);
});

test('selectPublishComment picks the oldest bot comment with the marker', () => {
  const bot = { id: GITHUB_ACTIONS_BOT_ID };
  const comments = [
    { id: 3, user: bot, body: body() },
    { id: 1, user: { id: 1 }, body: body() }, // human pasting the marker
    { id: 2, user: bot, body: 'unrelated bot comment' },
    { id: 4, user: bot, body: body() },
  ];
  const { comment, duplicates } = selectPublishComment(comments);
  assert.equal(comment.id, 3);
  assert.deepEqual(duplicates.map((c) => c.id), [4]);
  assert.equal(selectPublishComment([]).comment, null);
});

test('decide: state machine', () => {
  const request = { requestId: uuid, headSha: sha, htmlSha256: 'e'.repeat(64) };
  assert.equal(decide({ existing: null, request, runNumber: 5 }).action, 'proceed');
  assert.equal(decide({ existing: meta, request, runNumber: 12 }).action, 'noop');
  // Same request from a different run id: the original artifact still exists.
  assert.equal(decide({ existing: { ...meta, run_id: 500 }, request, runNumber: 12, runId: '501' }).action, 'noop');
  // Same request, same run id: this is a re-run and GitHub deleted the artifact.
  assert.equal(decide({ existing: { ...meta, run_id: 500 }, request, runNumber: 12, runId: '500' }).action, 'republish');
  assert.equal(decide({ existing: { ...meta, run_id: 500 }, request, runNumber: 12, runId: 500 }).action, 'republish');
  assert.equal(decide({ existing: meta, request: { ...request, htmlSha256: 'f'.repeat(64) }, runNumber: 12 }).action, 'reject');
  const other = { ...request, requestId: '22222222-2222-4333-8444-555555555555' };
  assert.equal(decide({ existing: meta, request: other, runNumber: 11 }).action, 'skip');
  assert.equal(decide({ existing: meta, request: other, runNumber: 12 }).action, 'reject');
  assert.equal(decide({ existing: meta, request: other, runNumber: 13 }).action, 'proceed');
  assert.equal(decide({ existing: { request_id: 'x' }, request: other, runNumber: 1 }).action, 'proceed');
});
