// The few REST calls these actions make, over the runtime's own fetch so the
// action needs no dependencies and the tests can hand in a fake.

const PER_PAGE = 100;

// A runaway Link chain must not hold a job open; 50 pages is 5000 records.
const MAX_PAGES = 50;

const REQUEST_TIMEOUT_MS = 15000;

export function client({ fetch, token, apiUrl }) {
  async function request(method, path, { query, body } = {}) {
    const url = new URL(`${apiUrl}/${path}`);
    for (const [name, value] of Object.entries(query ?? {})) {
      url.searchParams.set(name, String(value));
    }
    const response = await fetch(url, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`${method} ${path} answered HTTP ${response.status}`);
    }
    return response.status === 204 ? null : response.json().catch(() => null);
  }

  // Calls `visit` with each page's items until it returns true or the pages run
  // out, so no listing can forget to paginate.
  async function eachPage(path, key, query, visit) {
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const body = await request("GET", path, { query: { ...query, per_page: PER_PAGE, page } });
      if (!Array.isArray(body?.[key])) {
        throw new Error(`GET ${path} answered without a ${key} list`);
      }
      if (visit(body[key]) || body[key].length < PER_PAGE) {
        return;
      }
    }
  }

  return { request, eachPage };
}
