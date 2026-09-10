import { execFileSync } from 'node:child_process';

/** Resolve a token: GITHUB_TOKEN, GH_TOKEN, then `gh auth token`. */
export function resolveToken(env = process.env) {
  if (env.GITHUB_TOKEN) return env.GITHUB_TOKEN;
  if (env.GH_TOKEN) return env.GH_TOKEN;
  try {
    const out = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (out) return out;
  } catch {
    // fall through
  }
  throw new Error('no GitHub token: set GITHUB_TOKEN or GH_TOKEN, or log in with `gh auth login`');
}
