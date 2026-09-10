// Step 1-2: validate the request, decide whether to proceed, fetch and verify the HTML.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GitHubClient } from '../lib/github.mjs';
import { artifactFileName, relayAssetName } from '../lib/naming.mjs';
import { decide, parseMeta, selectPublishComment } from '../lib/comment.mjs';
import { DEFAULT_MAX_HTML_BYTES, ValidationError, validateDispatchInputs, validateHtmlBytes, validatePositiveInt } from '../lib/validate.mjs';
import { context, getInput, info, notice, runMain, setOutput, summary, warning } from './core.mjs';

function finish(status, reason) {
  setOutput('status', status);
  setOutput('reason', reason);
  if (status === 'skipped') warning(`publish skipped: ${reason}`);
  else notice(`publish ${status}: ${reason}`);
  summary(`### publish-pr-html\n\n- 結果: **${status}**\n- 理由: ${reason}`);
}

runMain(async () => {
  const ctx = context();
  const request = validateDispatchInputs({
    pr_number: getInput('pr_number'),
    head_sha: getInput('head_sha'),
    request_id: getInput('request_id'),
    html_sha256: getInput('html_sha256'),
    transport: getInput('transport'),
    html: getInput('html'),
    asset_id: getInput('asset_id'),
  });
  const maxBytes = validatePositiveInt(getInput('max_bytes') || String(DEFAULT_MAX_HTML_BYTES), 'max_bytes');
  const authorId = validatePositiveInt(getInput('comment_author_id') || '41898282', 'comment_author_id');
  const releaseIdInput = getInput('release_id').trim();
  const gh = new GitHubClient({ token: getInput('github_token', { required: true }), apiUrl: ctx.apiUrl });

  setOutput('pr_number', String(request.prNumber));
  setOutput('head_sha', request.headSha);
  setOutput('request_id', request.requestId);

  // Only runs on the default branch are trusted.
  const repoInfo = await gh.get(`/repos/${ctx.repo}`);
  const trustedRef = `refs/heads/${repoInfo.default_branch}`;
  if (ctx.ref !== trustedRef) throw new ValidationError(`refusing to run on ${ctx.ref}; only ${trustedRef} is trusted`);

  // PR must exist, be open and still point at the described commit.
  let pr;
  try {
    pr = await gh.get(`/repos/${ctx.repo}/pulls/${request.prNumber}`);
  } catch (err) {
    if (err.status === 404) throw new ValidationError(`PR #${request.prNumber} not found`);
    throw err;
  }
  if (pr.state !== 'open') return finish('skipped', `PR #${request.prNumber} is ${pr.state}`);
  if (pr.head.sha !== request.headSha) {
    return finish('skipped', `PR #${request.prNumber} head is ${pr.head.sha.slice(0, 12)}, request describes ${request.headSha.slice(0, 12)}`);
  }

  // Look at the existing comment before fetching anything (the relay asset may already be gone).
  const comments = await gh.paginate(`/repos/${ctx.repo}/issues/${request.prNumber}/comments`);
  const { comment, duplicates } = selectPublishComment(comments, { authorId });
  if (duplicates.length > 0) warning(`found ${duplicates.length} duplicate publish comment(s); using the oldest (${comment.html_url})`);
  const existing = comment ? parseMeta(comment.body) : null;
  if (comment && !existing) warning(`existing publish comment ${comment.html_url} has no readable metadata; it will be replaced`);
  const decision = decide({ existing, request, runNumber: ctx.runNumber, runId: ctx.runId });
  if (decision.action === 'republish') warning(decision.reason);
  if (decision.action === 'noop') return finish('noop', decision.reason);
  if (decision.action === 'skip') return finish('skipped', decision.reason);
  if (decision.action === 'reject') throw new ValidationError(decision.reason);

  // Fetch the HTML.
  let bytes;
  if (request.transport === 'inline') {
    bytes = Buffer.from(request.html, 'utf8');
    info(`inline HTML: ${bytes.length} bytes`);
  } else {
    if (releaseIdInput === '') throw new ValidationError('transport=release requires release_id (set the PR_HTML_RELEASE_ID repository variable)');
    const releaseId = validatePositiveInt(releaseIdInput, 'release_id');
    const release = await gh.get(`/repos/${ctx.repo}/releases/${releaseId}`);
    if (release.draft !== true) throw new ValidationError(`release ${releaseId} is not a draft; refusing to use it as a relay`);
    const assets = await gh.paginate(`/repos/${ctx.repo}/releases/${releaseId}/assets`);
    const asset = assets.find((a) => a.id === request.assetId);
    if (!asset) throw new ValidationError(`asset ${request.assetId} is not under relay release ${releaseId}`);
    const expectedName = relayAssetName(request);
    if (asset.name !== expectedName) throw new ValidationError(`asset ${request.assetId} is named "${asset.name}", expected "${expectedName}"`);
    if (typeof asset.size === 'number' && asset.size > maxBytes) throw new ValidationError(`asset size ${asset.size} exceeds the limit of ${maxBytes} bytes`);
    bytes = await gh.downloadBytes(`/repos/${ctx.repo}/releases/assets/${request.assetId}`, { maxBytes });
    info(`relay asset ${asset.name}: ${bytes.length} bytes`);
  }
  validateHtmlBytes(bytes, { maxBytes, expectedSha256: request.htmlSha256 });

  const fileName = artifactFileName({ prNumber: request.prNumber, headSha: request.headSha, runId: ctx.runId, runAttempt: ctx.runAttempt });
  const dir = join(ctx.runnerTemp, 'publish-pr-html');
  mkdirSync(dir, { recursive: true });
  const htmlPath = join(dir, fileName);
  writeFileSync(htmlPath, bytes);

  setOutput('status', 'proceed');
  setOutput('reason', decision.reason);
  setOutput('html_path', htmlPath);
  setOutput('artifact_file', fileName);
  info(`verified ${bytes.length} bytes (sha256 ${request.htmlSha256}) -> ${fileName}`);
});
