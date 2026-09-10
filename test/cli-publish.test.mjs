import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publish } from '../src/cli/publish.mjs';
import { sha256Hex } from '../src/lib/hash.mjs';
import { COMMENT_MARKER, META_CLOSE, META_OPEN, relayAssetName } from '../src/lib/naming.mjs';
import { INLINE_LIMIT_BYTES } from '../src/lib/transport.mjs';

const sha = 'a'.repeat(40);
const repo = { owner: 'o', name: 'r' };

class FakeGitHub {
  constructor({ html, prState = 'open', prHead = sha, comments = [], runConclusion = 'success', publishComment = true }) {
    this.calls = [];
    this.html = html;
    this.prState = prState;
    this.prHead = prHead;
    this.comments = comments;
    this.runConclusion = runConclusion;
    this.publishComment = publishComment;
    this.dispatches = [];
    this.uploads = [];
  }

  async get(path) {
    this.calls.push(['GET', path]);
    if (path === '/repos/o/r') return { default_branch: 'main' };
    if (path === '/repos/o/r/pulls/7') return { state: this.prState, head: { sha: this.prHead } };
    if (path.startsWith('/repos/o/r/actions/workflows/publish-pr-html.yml/runs')) {
      if (this.dispatches.length === 0) return { workflow_runs: [] };
      const rid = this.dispatches[0].inputs.request_id;
      return { workflow_runs: [{ id: 555, display_title: `publish-pr-html: PR #7 (${rid})`, html_url: 'https://github.com/o/r/actions/runs/555' }] };
    }
    if (path === '/repos/o/r/actions/workflows/publish-pr-html.yml') return { id: 1 };
    if (path === '/repos/o/r/actions/runs/555') return { status: 'completed', conclusion: this.runConclusion, html_url: 'https://github.com/o/r/actions/runs/555' };
    if (path === '/repos/o/r/actions/variables/PR_HTML_RELEASE_ID') return { value: '99' };
    if (path === '/repos/o/r/releases/99') return { draft: true, upload_url: 'https://uploads.github.com/repos/o/r/releases/99/assets{?name,label}' };
    throw Object.assign(new Error(`unexpected GET ${path}`), { status: 404 });
  }

  async post(path, body, options) {
    this.calls.push(['POST', path]);
    if (path.endsWith('/dispatches')) {
      this.dispatches.push(body);
      return null;
    }
    if (path.startsWith('https://uploads.github.com/')) {
      const name = decodeURIComponent(path.split('?name=')[1]);
      this.uploads.push({ name, bytes: body, contentType: options.headers['Content-Type'] });
      return { id: 4242, name };
    }
    throw new Error(`unexpected POST ${path}`);
  }

  async paginate(path) {
    this.calls.push(['GET', path]);
    if (path === '/repos/o/r/issues/7/comments') {
      if (!this.publishComment || this.dispatches.length === 0) return this.comments;
      const rid = this.dispatches[0].inputs.request_id;
      const meta = { request_id: rid, run_id: 555, artifact_id: 8 };
      return [...this.comments, { id: 1, html_url: 'https://github.com/o/r/pull/7#issuecomment-1', body: `${COMMENT_MARKER}\n${META_OPEN}${JSON.stringify(meta)}${META_CLOSE}` }];
    }
    throw new Error(`unexpected paginate ${path}`);
  }
}

function tmpHtml(content) {
  const dir = mkdtempSync(join(tmpdir(), 'pph-'));
  const file = join(dir, 'x.html');
  writeFileSync(file, content);
  return file;
}

const fast = { timeoutSec: 5 };

test('small HTML goes inline and is verified through the comment', async () => {
  const html = '<p>日本語 "q" $(x)</p>\r\n';
  const gh = new FakeGitHub({ html });
  const result = await publish({ gh, repo, prNumber: '7', headSha: sha, file: tmpHtml(html), ...fast });
  assert.equal(result.status, 'published');
  assert.equal(result.transport, 'inline');
  assert.equal(result.artifact_url, 'https://github.com/o/r/actions/runs/555/artifacts/8');
  assert.equal(result.comment_url, 'https://github.com/o/r/pull/7#issuecomment-1');
  const d = gh.dispatches[0];
  assert.equal(d.ref, 'main');
  assert.equal(d.inputs.html, html);
  assert.equal(d.inputs.html_sha256, sha256Hex(Buffer.from(html)));
  assert.equal(d.inputs.asset_id, undefined);
  assert.equal(gh.uploads.length, 0);
});

test('large HTML goes through the relay release', async () => {
  const html = '<p>' + 'x'.repeat(INLINE_LIMIT_BYTES) + '</p>';
  const gh = new FakeGitHub({ html });
  const result = await publish({ gh, repo, prNumber: '7', headSha: sha, file: tmpHtml(html), ...fast });
  assert.equal(result.status, 'published');
  assert.equal(result.transport, 'release');
  assert.equal(result.asset_id, 4242);
  const d = gh.dispatches[0];
  assert.equal(d.inputs.transport, 'release');
  assert.equal(d.inputs.asset_id, '4242');
  assert.equal(d.inputs.html, undefined);
  assert.equal(gh.uploads.length, 1);
  assert.equal(gh.uploads[0].name, relayAssetName({ prNumber: 7, headSha: sha, requestId: d.inputs.request_id }));
  assert.equal(gh.uploads[0].contentType, 'text/html; charset=utf-8');
  assert.ok(Buffer.from(html).equals(gh.uploads[0].bytes));
});

test('PR head mismatch and closed PR are refused before dispatch', async () => {
  const html = '<p>x</p>';
  await assert.rejects(publish({ gh: new FakeGitHub({ html, prHead: 'b'.repeat(40) }), repo, prNumber: '7', headSha: sha, file: tmpHtml(html), ...fast }), /head is/);
  await assert.rejects(publish({ gh: new FakeGitHub({ html, prState: 'closed' }), repo, prNumber: '7', headSha: sha, file: tmpHtml(html), ...fast }), /is closed/);
  await assert.rejects(publish({ gh: new FakeGitHub({ html }), repo, prNumber: '7', headSha: sha, file: tmpHtml(html), ref: 'feature', ...fast }), /default branch/);
});

test('successful run without our comment is reported as skipped; failed run as failed', async () => {
  const html = '<p>x</p>';
  const skipped = await publish({ gh: new FakeGitHub({ html, publishComment: false }), repo, prNumber: '7', headSha: sha, file: tmpHtml(html), ...fast });
  assert.equal(skipped.status, 'skipped');
  assert.equal(skipped.run_url, 'https://github.com/o/r/actions/runs/555');
  const failed = await publish({ gh: new FakeGitHub({ html, publishComment: false, runConclusion: 'failure' }), repo, prNumber: '7', headSha: sha, file: tmpHtml(html), ...fast });
  assert.equal(failed.status, 'failed');
});

test('--no-wait returns after the dispatch is accepted', async () => {
  const html = '<p>x</p>';
  const gh = new FakeGitHub({ html });
  const result = await publish({ gh, repo, prNumber: '7', headSha: sha, file: tmpHtml(html), wait: false });
  assert.equal(result.status, 'dispatched');
  assert.ok(!gh.calls.some(([, p]) => p.includes('/actions/runs')));
});
