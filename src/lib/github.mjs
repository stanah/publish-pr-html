// Minimal GitHub REST client on top of global fetch (Node >= 20). No dependencies.

export class GitHubApiError extends Error {
  constructor(message, { status, method, path, body } = {}) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = status;
    this.method = method;
    this.path = path;
    this.body = body;
  }
}

function parseLinkNext(header) {
  if (!header) return null;
  for (const part of header.split(',')) {
    const m = /<([^>]+)>;\s*rel="next"/.exec(part.trim());
    if (m) return m[1];
  }
  return null;
}

export class GitHubClient {
  constructor({ token, apiUrl = 'https://api.github.com', userAgent = 'publish-pr-html' }) {
    if (!token) throw new Error('a GitHub token is required');
    this.token = token;
    this.apiUrl = apiUrl.replace(/\/+$/, '');
    this.userAgent = userAgent;
  }

  url(path) {
    return /^https?:\/\//.test(path) ? path : `${this.apiUrl}${path.startsWith('/') ? '' : '/'}${path}`;
  }

  /** Low-level request. Returns the Response without consuming the body. */
  async raw(method, path, { body, headers = {}, redirect = 'follow' } = {}) {
    const init = {
      method,
      redirect,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        Authorization: `Bearer ${this.token}`,
        'User-Agent': this.userAgent,
        ...headers,
      },
    };
    if (body !== undefined) {
      if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
        init.body = body;
      } else {
        init.body = JSON.stringify(body);
        init.headers['Content-Type'] = 'application/json';
      }
    }
    return fetch(this.url(path), init);
  }

  async request(method, path, options = {}) {
    const res = await this.raw(method, path, options);
    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!res.ok) {
      const msg = data && typeof data === 'object' && data.message ? data.message : text.slice(0, 200);
      throw new GitHubApiError(`${method} ${path} -> ${res.status}: ${msg}`, { status: res.status, method, path, body: data });
    }
    return { status: res.status, headers: res.headers, data };
  }

  async get(path, options) {
    return (await this.request('GET', path, options)).data;
  }

  async post(path, body, options = {}) {
    return (await this.request('POST', path, { ...options, body })).data;
  }

  async patch(path, body, options = {}) {
    return (await this.request('PATCH', path, { ...options, body })).data;
  }

  async delete(path, options) {
    return this.request('DELETE', path, options);
  }

  /** Follow Link: rel="next" and concatenate array responses. */
  async paginate(path, { perPage = 100 } = {}) {
    let next = this.url(path) + (path.includes('?') ? '&' : '?') + `per_page=${perPage}`;
    const items = [];
    while (next) {
      const { headers, data } = await this.request('GET', next);
      if (!Array.isArray(data)) throw new GitHubApiError(`expected an array from ${next}`, { path: next });
      items.push(...data);
      next = parseLinkNext(headers.get('link'));
    }
    return items;
  }

  /**
   * Download binary content. Follows a redirect manually and does not forward
   * the Authorization header to the redirect target.
   */
  async downloadBytes(path, { accept = 'application/octet-stream', maxBytes } = {}) {
    let res = await this.raw('GET', path, { headers: { Accept: accept }, redirect: 'manual' });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      if (!location) throw new GitHubApiError(`redirect without Location from ${path}`, { status: res.status, path });
      res = await fetch(location, { headers: { 'User-Agent': this.userAgent }, redirect: 'follow' });
    }
    if (!res.ok) {
      const text = await res.text();
      throw new GitHubApiError(`GET ${path} -> ${res.status}: ${text.slice(0, 200)}`, { status: res.status, method: 'GET', path });
    }
    const declared = Number(res.headers.get('content-length'));
    if (maxBytes !== undefined && Number.isFinite(declared) && declared > maxBytes) {
      throw new GitHubApiError(`content-length ${declared} exceeds the limit of ${maxBytes} bytes`, { path });
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (maxBytes !== undefined && buf.length > maxBytes) {
      throw new GitHubApiError(`downloaded ${buf.length} bytes, exceeds the limit of ${maxBytes} bytes`, { path });
    }
    return buf;
  }
}

export function splitRepo(repo) {
  const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(String(repo || ''));
  if (!m) throw new Error(`repository must be OWNER/REPO, got "${repo}"`);
  return { owner: m[1], name: m[2] };
}
