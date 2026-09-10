// Daily cleanup: delete relay assets that follow our naming rule and are older than max_age_days.
import { GitHubClient } from '../lib/github.mjs';
import { parseRelayAssetName } from '../lib/naming.mjs';
import { DEFAULT_RELAY_MAX_AGE_DAYS, ValidationError, validatePositiveInt } from '../lib/validate.mjs';
import { context, getInput, info, runMain, setOutput, summary, warning } from './core.mjs';

runMain(async () => {
  const ctx = context();
  const releaseId = validatePositiveInt(getInput('release_id', { required: true }), 'release_id');
  const maxAgeDays = validatePositiveInt(getInput('max_age_days') || String(DEFAULT_RELAY_MAX_AGE_DAYS), 'max_age_days');
  const dryRun = getInput('dry_run').trim() === 'true';
  const gh = new GitHubClient({ token: getInput('github_token', { required: true }), apiUrl: ctx.apiUrl });

  const release = await gh.get(`/repos/${ctx.repo}/releases/${releaseId}`);
  if (release.draft !== true) throw new ValidationError(`release ${releaseId} is not a draft; refusing to clean it`);
  const assets = await gh.paginate(`/repos/${ctx.repo}/releases/${releaseId}/assets`);
  const cutoff = Date.now() - maxAgeDays * 86_400_000;

  const rows = [];
  let deleted = 0;
  let failed = 0;
  for (const asset of assets) {
    if (!parseRelayAssetName(asset.name)) {
      rows.push(`| ${asset.name} | ${asset.created_at} | 対象外（命名規則不一致） |`);
      continue;
    }
    const createdAt = Date.parse(asset.created_at);
    if (!Number.isFinite(createdAt) || createdAt > cutoff) {
      rows.push(`| ${asset.name} | ${asset.created_at} | 保持 |`);
      continue;
    }
    if (dryRun) {
      rows.push(`| ${asset.name} | ${asset.created_at} | 削除対象（dry run） |`);
      continue;
    }
    try {
      await gh.delete(`/repos/${ctx.repo}/releases/assets/${asset.id}`);
      deleted += 1;
      info(`deleted ${asset.name}`);
      rows.push(`| ${asset.name} | ${asset.created_at} | 削除 |`);
    } catch (err) {
      failed += 1;
      warning(`could not delete ${asset.name}: ${err.message}`);
      rows.push(`| ${asset.name} | ${asset.created_at} | 削除失敗 |`);
    }
  }
  setOutput('deleted', String(deleted));
  setOutput('failed', String(failed));
  summary(`### cleanup-pr-html\n\n- release: ${releaseId}（draft）\n- 期限: ${maxAgeDays}日\n- 削除: ${deleted} / 失敗: ${failed} / 総数: ${assets.length}\n\n| asset | 作成日時 | 処理 |\n|---|---|---|\n${rows.join('\n')}`);
  if (failed > 0) process.exitCode = 1;
});
