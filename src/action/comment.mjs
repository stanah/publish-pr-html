// Step 4: re-check the PR and publication order, then create or update the dedicated comment.
import { GitHubClient } from '../lib/github.mjs';
import { buildCommentBody, decide, parseMeta, selectPublishComment } from '../lib/comment.mjs';
import { DEFAULT_RETENTION_DAYS, ValidationError, validateFullSha, validatePositiveInt, validatePrNumber, validateRequestId, validateSha256 } from '../lib/validate.mjs';
import { context, getEnv, getInput, info, notice, runMain, setOutput, summary, warning } from './core.mjs';

function finish(status, reason) {
  setOutput('status', status);
  setOutput('reason', reason);
  warning(`comment not updated (${status}): ${reason}`);
  summary(`### publish-pr-html\n\n- 結果: **${status}**\n- 理由: ${reason}\n- artifactは作成済みですが、コメントは更新していません。`);
}

runMain(async () => {
  const ctx = context();
  const request = {
    prNumber: validatePrNumber(getInput('pr_number')),
    headSha: validateFullSha(getInput('head_sha')),
    requestId: validateRequestId(getInput('request_id')),
    htmlSha256: validateSha256(getInput('html_sha256')),
  };
  const retentionDays = validatePositiveInt(getInput('retention_days') || String(DEFAULT_RETENTION_DAYS), 'retention_days');
  const authorId = validatePositiveInt(getInput('comment_author_id') || '41898282', 'comment_author_id');
  const artifactUrl = getEnv('ARTIFACT_URL');
  const artifactId = validatePositiveInt(getEnv('ARTIFACT_ID'), 'artifact id');
  const expectedArtifactUrl = `${ctx.serverUrl}/${ctx.repo}/actions/runs/${ctx.runId}/artifacts/${artifactId}`;
  if (artifactUrl !== expectedArtifactUrl) throw new ValidationError(`unexpected artifact URL "${artifactUrl}"`);
  const gh = new GitHubClient({ token: getInput('github_token', { required: true }), apiUrl: ctx.apiUrl });

  const pr = await gh.get(`/repos/${ctx.repo}/pulls/${request.prNumber}`);
  if (pr.state !== 'open') return finish('skipped', `PR #${request.prNumber} is ${pr.state}`);
  if (pr.head.sha !== request.headSha) {
    return finish('skipped', `PR #${request.prNumber} head moved to ${pr.head.sha.slice(0, 12)} while publishing ${request.headSha.slice(0, 12)}`);
  }

  const comments = await gh.paginate(`/repos/${ctx.repo}/issues/${request.prNumber}/comments`);
  const { comment, duplicates } = selectPublishComment(comments, { authorId });
  if (duplicates.length > 0) warning(`found ${duplicates.length} duplicate publish comment(s); updating the oldest only`);
  const existing = comment ? parseMeta(comment.body) : null;
  const decision = decide({ existing, request, runNumber: ctx.runNumber });
  if (decision.action === 'noop' || decision.action === 'skip') return finish('skipped', decision.reason);
  if (decision.action === 'reject') throw new ValidationError(decision.reason);

  const publishedAt = new Date().toISOString();
  const runUrl = `${ctx.serverUrl}/${ctx.repo}/actions/runs/${ctx.runId}`;
  const body = buildCommentBody({
    serverUrl: ctx.serverUrl,
    repo: ctx.repo,
    artifactUrl,
    headSha: request.headSha,
    publishedAt,
    retentionDays,
    runUrl,
    meta: {
      request_id: request.requestId,
      head_sha: request.headSha,
      html_sha256: request.htmlSha256,
      run_number: ctx.runNumber,
      run_id: Number(ctx.runId),
      artifact_id: artifactId,
      published_at: publishedAt,
    },
  });

  let result;
  if (comment) {
    result = await gh.patch(`/repos/${ctx.repo}/issues/comments/${comment.id}`, { body });
    info(`updated comment ${result.html_url}`);
  } else {
    result = await gh.post(`/repos/${ctx.repo}/issues/${request.prNumber}/comments`, { body });
    info(`created comment ${result.html_url}`);
  }
  setOutput('status', 'published');
  setOutput('reason', decision.reason);
  setOutput('comment_url', result.html_url);
  setOutput('comment_id', String(result.id));
  notice(`published ${artifactUrl} -> ${result.html_url}`);
  summary(`### publish-pr-html\n\n- 結果: **published**\n- HTML: ${artifactUrl}\n- コメント: ${result.html_url}\n- 対象コミット: \`${request.headSha}\`\n- 保持期間: ${retentionDays}日`);
});
