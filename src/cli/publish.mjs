// The publish flow used by the CLI. `gh` is a GitHubClient-compatible object so the flow can be tested.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { sha256Hex } from '../lib/hash.mjs';
import { relayAssetName } from '../lib/naming.mjs';
import { parseMeta } from '../lib/comment.mjs';
import { buildDispatchPayload, chooseTransport } from '../lib/transport.mjs';
import { DEFAULT_MAX_HTML_BYTES, ValidationError, validateFullSha, validateHtmlBytes, validatePositiveInt, validatePrNumber } from '../lib/validate.mjs';

export const RELEASE_ID_VARIABLE = 'PR_HTML_RELEASE_ID';
export const DEFAULT_WORKFLOW_FILE = 'publish-pr-html.yml';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function resolveReleaseId({ gh, owner, name, explicit, env = process.env }) {
  if (explicit) return validatePositiveInt(explicit, 'release id');
  if (env[RELEASE_ID_VARIABLE]) return validatePositiveInt(env[RELEASE_ID_VARIABLE], RELEASE_ID_VARIABLE);
  try {
    const variable = await gh.get(`/repos/${owner}/${name}/actions/variables/${RELEASE_ID_VARIABLE}`);
    return validatePositiveInt(variable.value, RELEASE_ID_VARIABLE);
  } catch (err) {
    throw new Error(`could not resolve the relay release id (${err.message}); run "publish-pr-html setup --repo ${owner}/${name}" or pass --release-id`);
  }
}

export async function uploadRelayAsset({ gh, owner, name, releaseId, assetName, bytes }) {
  const release = await gh.get(`/repos/${owner}/${name}/releases/${releaseId}`);
  if (release.draft !== true) throw new ValidationError(`release ${releaseId} is not a draft; refusing to use it as a relay`);
  const uploadUrl = `${String(release.upload_url).replace(/\{[^}]*\}$/, '')}?name=${encodeURIComponent(assetName)}`;
  const asset = await gh.post(uploadUrl, bytes, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  if (asset.name !== assetName) throw new Error(`uploaded asset is named "${asset.name}", expected "${assetName}"`);
  return asset;
}

export async function findRun({ gh, owner, name, workflow, requestId, since, timeoutMs, intervalMs = 3000 }) {
  const deadline = Date.now() + timeoutMs;
  const created = new Date(since.getTime() - 120_000).toISOString();
  while (Date.now() < deadline) {
    const res = await gh.get(`/repos/${owner}/${name}/actions/workflows/${encodeURIComponent(workflow)}/runs?event=workflow_dispatch&created=%3E%3D${encodeURIComponent(created)}&per_page=50`);
    const run = (res.workflow_runs || []).find((r) => typeof r.display_title === 'string' && r.display_title.includes(requestId));
    if (run) return run;
    await sleep(intervalMs);
  }
  return null;
}

export async function waitForRun({ gh, owner, name, runId, timeoutMs, intervalMs = 5000 }) {
  const deadline = Date.now() + timeoutMs;
  let run;
  while (Date.now() < deadline) {
    run = await gh.get(`/repos/${owner}/${name}/actions/runs/${runId}`);
    if (run.status === 'completed') return run;
    await sleep(intervalMs);
  }
  return run;
}

export async function findPublishedComment({ gh, owner, name, prNumber, requestId }) {
  const comments = await gh.paginate(`/repos/${owner}/${name}/issues/${prNumber}/comments`);
  for (const c of comments) {
    const meta = parseMeta(c.body);
    if (meta && meta.request_id === requestId) return { comment: c, meta };
  }
  return null;
}

/**
 * Publish `file` for PR `prNumber` at `headSha`. Returns a result object; never throws for
 * "not published" outcomes once the dispatch has been accepted (see result.status).
 */
export async function publish({ gh, repo, prNumber, headSha, file, workflow = DEFAULT_WORKFLOW_FILE, ref, releaseId, maxBytes = DEFAULT_MAX_HTML_BYTES, wait = true, timeoutSec = 900, log = () => {}, env = process.env }) {
  const { owner, name } = repo;
  const pr = validatePrNumber(prNumber);
  const sha = validateFullSha(headSha);
  const bytes = readFileSync(file);
  const htmlSha256 = validateHtmlBytes(bytes, { maxBytes });
  const requestId = randomUUID();
  log(`request_id=${requestId}`);
  log(`html: ${bytes.length} bytes, sha256=${htmlSha256}`);

  const repoInfo = await gh.get(`/repos/${owner}/${name}`);
  const targetRef = ref || repoInfo.default_branch;
  if (targetRef !== repoInfo.default_branch) throw new ValidationError(`ref must be the default branch (${repoInfo.default_branch}), got "${targetRef}"`);

  let prInfo;
  try {
    prInfo = await gh.get(`/repos/${owner}/${name}/pulls/${pr}`);
  } catch (err) {
    if (err.status === 404) throw new ValidationError(`PR #${pr} not found in ${owner}/${name}`);
    throw err;
  }
  if (prInfo.state !== 'open') throw new ValidationError(`PR #${pr} is ${prInfo.state}`);
  if (prInfo.head.sha !== sha) throw new ValidationError(`PR #${pr} head is ${prInfo.head.sha}, but --head-sha is ${sha}; regenerate the HTML for the current head or pass the matching SHA`);

  try {
    await gh.get(`/repos/${owner}/${name}/actions/workflows/${encodeURIComponent(workflow)}`);
  } catch (err) {
    if (err.status === 404) throw new ValidationError(`workflow ${workflow} is not installed in ${owner}/${name}; copy templates/publish-pr-html.yml to .github/workflows/ on ${repoInfo.default_branch}`);
    throw err;
  }

  const choice = chooseTransport({ ref: targetRef, prNumber: pr, headSha: sha, requestId, htmlSha256, html: bytes.toString('utf8') });
  log(`transport=${choice.transport} (inline payload would be ${choice.bytes} bytes)`);

  let payload = choice.payload;
  let asset = null;
  if (choice.transport === 'release') {
    const relayId = await resolveReleaseId({ gh, owner, name, explicit: releaseId, env });
    const assetName = relayAssetName({ prNumber: pr, headSha: sha, requestId });
    asset = await uploadRelayAsset({ gh, owner, name, releaseId: relayId, assetName, bytes });
    log(`uploaded relay asset ${asset.name} (id ${asset.id}) to draft release ${relayId}`);
    payload = buildDispatchPayload({ ref: targetRef, prNumber: pr, headSha: sha, requestId, htmlSha256, transport: 'release', assetId: asset.id });
  }

  const dispatchedAt = new Date();
  await gh.post(`/repos/${owner}/${name}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, payload);
  log('dispatch accepted (this is not yet a successful publish)');

  const result = { status: 'dispatched', request_id: requestId, transport: choice.transport, pr_number: pr, head_sha: sha, html_sha256: htmlSha256, asset_id: asset ? asset.id : null };
  if (!wait) return result;

  const timeoutMs = timeoutSec * 1000;
  const run = await findRun({ gh, owner, name, workflow, requestId, since: dispatchedAt, timeoutMs: Math.min(timeoutMs, 180_000) });
  if (!run) return { ...result, status: 'timeout', reason: 'the dispatched run did not appear in time' };
  result.run_url = run.html_url;
  log(`run: ${run.html_url}`);

  const finished = await waitForRun({ gh, owner, name, runId: run.id, timeoutMs });
  if (!finished || finished.status !== 'completed') return { ...result, status: 'timeout', reason: 'the run did not complete in time' };
  result.conclusion = finished.conclusion;

  const found = await findPublishedComment({ gh, owner, name, prNumber: pr, requestId });
  if (found) {
    const artifactUrl = `${(finished.html_url || '').replace(/\/actions\/runs\/\d+$/, '')}/actions/runs/${found.meta.run_id}/artifacts/${found.meta.artifact_id}`;
    return { ...result, status: 'published', comment_url: found.comment.html_url, artifact_url: artifactUrl };
  }
  if (finished.conclusion === 'success') return { ...result, status: 'skipped', reason: 'the run finished without publishing this request (PR head moved, PR closed, or a newer publication exists); see run_url' };
  return { ...result, status: 'failed', reason: `run concluded with ${finished.conclusion}; see run_url` };
}
