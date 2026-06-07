// Shared HTTP helper with 5xx/429 backoff. All adapters poll upstream data
// sources through this. Empty/missing keys cause callers to short-circuit
// before reaching here, so the app boots gracefully with no credentials.

export const HTTP_TIMEOUT_MS = 12000;
export const HTTP_RETRIES = 3;

const UA = { "User-Agent": "eea-sports-jarvis/1.0" };

export interface FetchResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  headers: Record<string, string>;
  error?: string;
}

function backoffMs(attempt: number, retryAfter?: string | null): number {
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (!Number.isNaN(secs) && secs > 0) return Math.min(secs * 1000, 15000);
  }
  // exponential: 500ms, 1000ms, 2000ms …
  return Math.min(500 * 2 ** attempt, 8000);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// GET JSON with retry on 429 + 5xx. Never throws — returns a result envelope.
export async function getJson<T = unknown>(
  url: string,
  params?: Record<string, string | number | undefined>,
  headers: Record<string, string> = {},
): Promise<FetchResult<T>> {
  const qs = params
    ? "?" +
      Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== null && v !== "")
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join("&")
    : "";
  const full = url + qs;

  let lastErr = "";
  for (let attempt = 0; attempt < HTTP_RETRIES; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
    try {
      const res = await fetch(full, {
        headers: { ...UA, ...headers },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const hdrs: Record<string, string> = {};
      res.headers.forEach((v, k) => (hdrs[k] = v));

      if (res.status === 200) {
        const data = (await res.json()) as T;
        return { ok: true, status: 200, data, headers: hdrs };
      }
      if (res.status === 429 || res.status >= 500) {
        lastErr = `HTTP ${res.status}`;
        await sleep(backoffMs(attempt, hdrs["retry-after"]));
        continue;
      }
      // 4xx other than 429 — not retryable
      return { ok: false, status: res.status, data: null, headers: hdrs, error: `HTTP ${res.status}` };
    } catch (e) {
      clearTimeout(timer);
      lastErr = e instanceof Error ? e.message : String(e);
      await sleep(backoffMs(attempt));
    }
  }
  return { ok: false, status: 0, data: null, headers: {}, error: lastErr };
}
