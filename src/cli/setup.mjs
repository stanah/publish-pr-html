// One-time setup: create the dedicated draft release used as a relay and record its id.
import { RELEASE_ID_VARIABLE } from './publish.mjs';

export const DEFAULT_RELAY_TAG = 'pr-html-relay';

export async function setup({ gh, repo, tag = DEFAULT_RELAY_TAG, log = () => {} }) {
  const { owner, name } = repo;
  const repoInfo = await gh.get(`/repos/${owner}/${name}`);

  const releases = await gh.paginate(`/repos/${owner}/${name}/releases`);
  let release = releases.find((r) => r.draft === true && r.tag_name === tag);
  if (release) {
    log(`reusing draft release ${release.id} (${tag})`);
  } else {
    if (releases.some((r) => r.tag_name === tag)) throw new Error(`a published release already uses tag ${tag}; choose another --tag`);
    release = await gh.post(`/repos/${owner}/${name}/releases`, {
      tag_name: tag,
      target_commitish: repoInfo.default_branch,
      name: 'publish-pr-html relay (do not publish)',
      body: 'Relay storage for publish-pr-html. Assets here are temporary and deleted after publication. Keep this release as a draft.',
      draft: true,
      prerelease: true,
    });
    log(`created draft release ${release.id} (${tag})`);
  }

  let variableSet = false;
  try {
    let existing = null;
    try {
      existing = await gh.get(`/repos/${owner}/${name}/actions/variables/${RELEASE_ID_VARIABLE}`);
    } catch (err) {
      if (err.status !== 404) throw err;
    }
    if (existing) {
      if (existing.value !== String(release.id)) {
        await gh.patch(`/repos/${owner}/${name}/actions/variables/${RELEASE_ID_VARIABLE}`, { name: RELEASE_ID_VARIABLE, value: String(release.id) });
      }
    } else {
      await gh.post(`/repos/${owner}/${name}/actions/variables`, { name: RELEASE_ID_VARIABLE, value: String(release.id) });
    }
    variableSet = true;
    log(`repository variable ${RELEASE_ID_VARIABLE}=${release.id}`);
  } catch (err) {
    log(`could not set repository variable ${RELEASE_ID_VARIABLE} (${err.message}); set it manually to ${release.id}`);
  }
  return { release_id: release.id, tag, variable_set: variableSet, release_url: release.html_url };
}
