// Step 5: delete the relay asset only after the comment was updated. Failures here are warnings.
import { GitHubClient } from '../lib/github.mjs';
import { parseRelayAssetName } from '../lib/naming.mjs';
import { validatePositiveInt } from '../lib/validate.mjs';
import { context, getEnv, getInput, info, notice, runMain, summary, warning } from './core.mjs';

runMain(async () => {
  const ctx = context();
  const transport = getInput('transport').trim();
  const commentStatus = getEnv('COMMENT_STATUS', { required: false });
  if (transport !== 'release') return;
  if (commentStatus !== 'published') {
    notice(`relay asset kept because the comment status is "${commentStatus || 'unknown'}"; the cleanup workflow will remove it later`);
    return;
  }
  const assetId = validatePositiveInt(getInput('asset_id'), 'asset_id');
  const releaseId = validatePositiveInt(getInput('release_id'), 'release_id');
  const gh = new GitHubClient({ token: getInput('github_token', { required: true }), apiUrl: ctx.apiUrl });
  try {
    const assets = await gh.paginate(`/repos/${ctx.repo}/releases/${releaseId}/assets`);
    const asset = assets.find((a) => a.id === assetId);
    if (!asset) throw new Error(`asset ${assetId} is not under release ${releaseId}`);
    if (!parseRelayAssetName(asset.name)) throw new Error(`asset ${assetId} ("${asset.name}") does not follow the relay naming rule`);
    await gh.delete(`/repos/${ctx.repo}/releases/assets/${assetId}`);
    info(`deleted relay asset ${asset.name}`);
    summary(`- 中継asset \`${asset.name}\` を削除しました。`);
  } catch (err) {
    warning(`cleanup warning: could not delete relay asset ${assetId}: ${err.message}`);
    summary(`- 中継asset ${assetId} の削除に失敗しました。公開は成功しています。日次の清掃に委ねます。`);
  }
});
