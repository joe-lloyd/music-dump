import { getAccessToken } from './auth.ts';

const API = 'https://api.spotify.com/v1';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function get<T>(pathOrUrl: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(pathOrUrl.startsWith('http') ? pathOrUrl : API + pathOrUrl);
  for (const [key, value] of Object.entries(params ?? {})) {
    url.searchParams.set(key, value);
  }

  for (let attempt = 1; ; attempt++) {
    const token = await getAccessToken();
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });

    if (res.status === 429) {
      const waitSec = Number(res.headers.get('retry-after')) || 5;
      console.log(`  rate limited, waiting ${waitSec}s...`);
      await sleep(waitSec * 1000 + 500);
      continue;
    }
    if (res.status >= 500 && attempt <= 5) {
      await sleep(1000 * attempt);
      continue;
    }
    if (!res.ok) {
      throw new ApiError(`GET ${url.pathname}${url.search} failed (${res.status}): ${await res.text()}`, res.status);
    }
    return (await res.json()) as T;
  }
}

export interface Page<T> {
  items: T[];
  next: string | null;
  total?: number;
}

// Follows `next` links until exhausted, yielding one page of items at a time.
// `unwrap` picks the paging container out of the response body for endpoints
// that nest it (e.g. /me/following nests it under `artists`).
export async function* paginate<T>(
  path: string,
  params: Record<string, string> = {},
  unwrap: (body: unknown) => Page<T> = (body) => body as Page<T>,
): AsyncGenerator<Page<T>> {
  let body: unknown = await get(path, { limit: '50', ...params });
  while (true) {
    const page = unwrap(body);
    yield page;
    if (!page.next) return;
    body = await get(page.next);
  }
}
