import { COMMENT_MARKER, META_CLOSE, META_OPEN } from './naming.mjs';

export const GITHUB_ACTIONS_BOT_ID = 41898282;

/** Extract the hidden metadata JSON from a comment body. Returns null when absent or malformed. */
export function parseMeta(body) {
  if (typeof body !== 'string' || !body.includes(COMMENT_MARKER)) return null;
  const start = body.lastIndexOf(META_OPEN);
  if (start < 0) return null;
  const end = body.indexOf(META_CLOSE, start + META_OPEN.length);
  if (end < 0) return null;
  try {
    const meta = JSON.parse(body.slice(start + META_OPEN.length, end));
    if (!meta || typeof meta !== 'object') return null;
    return meta;
  } catch {
    return null;
  }
}

export function isPublishComment(comment, { authorId = GITHUB_ACTIONS_BOT_ID } = {}) {
  return Boolean(comment && comment.user && comment.user.id === authorId && typeof comment.body === 'string' && comment.body.includes(COMMENT_MARKER));
}

/** Pick the canonical publish comment: the oldest one. Returns {comment, duplicates}. */
export function selectPublishComment(comments, { authorId = GITHUB_ACTIONS_BOT_ID } = {}) {
  const ours = comments.filter((c) => isPublishComment(c, { authorId })).sort((a, b) => a.id - b.id);
  return { comment: ours[0] ?? null, duplicates: ours.slice(1) };
}

function fmtUtc(date) {
  return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

/** Build the comment body. All interpolated values are validated identifiers or URLs we generated. */
export function buildCommentBody({ serverUrl, repo, artifactUrl, headSha, publishedAt, retentionDays, runUrl, meta }) {
  const published = new Date(publishedAt);
  const expires = new Date(published.getTime() + retentionDays * 86_400_000);
  const commitUrl = `${serverUrl}/${repo}/commit/${headSha}`;
  const metaJson = JSON.stringify(meta);
  if (metaJson.includes('-->')) throw new Error('metadata must not contain "-->"');
  return [
    COMMENT_MARKER,
    '### PR解説HTML',
    '',
    `**[HTMLを開く](${artifactUrl})**`,
    '',
    'GitHubにログインしたブラウザでそのまま閲覧できます。ZIPの展開は不要です。',
    '',
    '| 項目 | 値 |',
    '|---|---|',
    `| 対象コミット | [\`${headSha.slice(0, 12)}\`](${commitUrl}) |`,
    `| 公開日時 | ${fmtUtc(published)} |`,
    `| 保持期限 | ${retentionDays}日（${expires.toISOString().slice(0, 10)} まで） |`,
    `| workflow run | ${runUrl} |`,
    '',
    '<sub>このコメントは publish-pr-html が自動で更新します。対象コミットは上記のとおりで、PRの最新コミットとは限りません。</sub>',
    `${META_OPEN}${metaJson}${META_CLOSE}`,
    '',
  ].join('\n');
}

/**
 * Decide what a run should do given the existing comment metadata.
 * Returns {action: 'proceed' | 'noop' | 'skip' | 'reject', reason}.
 */
export function decide({ existing, request, runNumber }) {
  if (!existing) return { action: 'proceed', reason: 'no existing comment' };
  const existingRun = Number(existing.run_number);
  if (existing.request_id === request.requestId) {
    if (existing.head_sha === request.headSha && existing.html_sha256 === request.htmlSha256) {
      return { action: 'noop', reason: `request ${request.requestId} is already published` };
    }
    return { action: 'reject', reason: `request ${request.requestId} is already published with different content` };
  }
  if (Number.isFinite(existingRun) && existingRun > runNumber) {
    return { action: 'skip', reason: `comment was written by a newer run #${existingRun}; this run is #${runNumber}` };
  }
  if (Number.isFinite(existingRun) && existingRun === runNumber) {
    return { action: 'reject', reason: `comment was written by this run #${runNumber} for a different request` };
  }
  return { action: 'proceed', reason: existing.run_number === undefined ? 'existing comment has no run_number' : `newer than run #${existingRun}` };
}
