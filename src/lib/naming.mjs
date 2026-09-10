// Naming rules shared by the CLI and the action.
// All names are derived only from validated inputs, so they are safe to use in
// file paths, asset names and log lines.

export const COMMENT_MARKER = '<!-- pr-html-explanation:v1 -->';
export const META_OPEN = '<!-- pr-html-meta ';
export const META_CLOSE = ' -->';

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;
export const POSITIVE_INT_PATTERN = /^[1-9][0-9]*$/;

export const RELAY_ASSET_PATTERN =
  /^pr-html-([1-9][0-9]*)-([0-9a-f]{12})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.html$/;

export function shortSha(sha) {
  return sha.slice(0, 12);
}

/** Name of the relay asset placed on the dedicated draft release. */
export function relayAssetName({ prNumber, headSha, requestId }) {
  return `pr-html-${prNumber}-${shortSha(headSha)}-${requestId}.html`;
}

/** Parse a relay asset name. Returns null when the name is not ours. */
export function parseRelayAssetName(name) {
  const m = RELAY_ASSET_PATTERN.exec(name);
  if (!m) return null;
  return { prNumber: Number(m[1]), shortSha: m[2], requestId: m[3] };
}

/** File name of the non-zipped artifact. Unique per run attempt. */
export function artifactFileName({ prNumber, headSha, runId, runAttempt }) {
  return `pr-${prNumber}-${shortSha(headSha)}-${runId}-${runAttempt}.html`;
}
