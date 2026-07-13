import dns from "node:dns/promises";
import net from "node:net";

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_BYTES = 256 * 1024;
const MAX_REDIRECTS = 3;

/** Thrown by every guard/failure path below — a portable (non-Next.js) `status` + `message`
 * pair. apps/web's own `fetchPublicJson.ts` wraps this back into its route-level `ApiError` at
 * the boundary, so every existing caller there keeps its exact prior behavior; this package has
 * no HTTP-framework dependency of its own, so it can't throw `ApiError` directly. */
export class GuardedFetchError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function isPrivateIp(ip: string): boolean {
  const type = net.isIP(ip);
  if (type === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  if (type === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
    if (lower.startsWith("::ffff:")) {
      const v4 = lower.slice("::ffff:".length);
      return net.isIP(v4) === 4 ? isPrivateIp(v4) : false;
    }
    return false;
  }
  return true; // not a parseable IP — treat as unsafe
}

// Best-effort SSRF guard: rejects literal private/loopback/link-local addresses and hostnames
// that resolve to one. Doesn't pin the resolved IP for the actual request, so a fast DNS-rebind
// between this check and fetch() below is a known residual gap — acceptable for this feature's
// threat model (importing a public agent manifest, relaying to a registered agent's declared
// endpoint, or an agent's own runtime calling a skill's declared endpoint), flagged here rather
// than silently ignored.
async function assertPublicHost(hostname: string): Promise<void> {
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new GuardedFetchError(400, `Refusing to fetch a private address (${hostname}).`);
    return;
  }
  if (hostname === "localhost") throw new GuardedFetchError(400, "Refusing to fetch localhost.");

  let addresses: string[];
  try {
    addresses = (await dns.lookup(hostname, { all: true })).map((r) => r.address);
  } catch {
    throw new GuardedFetchError(400, `Couldn't resolve host "${hostname}".`);
  }
  if (addresses.length === 0 || addresses.some(isPrivateIp)) {
    throw new GuardedFetchError(400, `Refusing to fetch "${hostname}" — it resolves to a private address.`);
  }
}

export interface FetchGuardedOptions {
  method?: "GET" | "POST";
  /** JSON-serializable body. When present, sent as `application/json` and the request itself
   * uses "POST" semantics — the caller should still cap this value's size before calling, this
   * function only guards the *response* size. */
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** When false, a non-2xx status or a non-JSON body resolves as `{status, data: null}` instead
   * of throwing — for callers that need to inspect an "unsuccessful" HTTP response themselves
   * (e.g. an x402 402 Payment Required with a JSON body, or a malformed reply from a third-party
   * agent/skill) rather than treating it as a hard failure. Network-level failures (unreachable
   * host, timeout, SSRF-blocked, bad URL/protocol) always throw regardless of this flag — this
   * only concerns what happens once a response actually came back. Defaults to true. */
  throwOnError?: boolean;
  /** false: skip JSON.parse and return the raw response text as `data` instead. Defaults to
   * true (existing behavior, every prior caller unaffected) — added for callers fetching
   * caller-declared content that isn't necessarily JSON (e.g. a knowledge-marketplace dataset,
   * routinely CSV/plain text). */
  expectJson?: boolean;
}

export interface FetchGuardedResult {
  status: number;
  data: unknown;
}

/** Fetches a caller-supplied (user-, agent-, or skill-declared) URL server-side and returns its
 * body parsed as JSON, with SSRF/size/time guards. GET requests auto-follow redirects
 * (re-validating each hop against the same guard); POST requests treat any 3xx as a terminal
 * response instead — HTTP redirect semantics for a POST body are ambiguous across
 * 301/302/303/307/308, `fetch`'s `redirect:"manual"` doesn't resolve that for us, and no
 * legitimate JSON-RPC agent/skill endpoint needs to redirect a POST anyway.
 *
 * Lives here (not apps/web) so both a Next.js route and this portable runtime (consumed by
 * apps/web and apps/indexer alike) share exactly one SSRF-guard implementation — see
 * apps/web/src/lib/server/fetchPublicJson.ts, which now just wraps this. */
export async function fetchGuarded(rawUrl: string, options: FetchGuardedOptions = {}): Promise<FetchGuardedResult> {
  const method = options.method ?? "GET";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const throwOnError = options.throwOnError ?? true;
  const expectJson = options.expectJson ?? true;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new GuardedFetchError(400, "Not a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new GuardedFetchError(400, "Only http(s) URLs are supported.");
  }

  const requestHeaders: Record<string, string> = { Accept: "application/json", ...options.headers };
  let requestBody: string | undefined;
  if (options.body !== undefined) {
    requestBody = JSON.stringify(options.body);
    requestHeaders["Content-Type"] = "application/json";
  }

  for (let redirects = 0; ; redirects++) {
    await assertPublicHost(url.hostname);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, { method, redirect: "manual", signal: controller.signal, headers: requestHeaders, body: requestBody });
    } catch {
      throw new GuardedFetchError(502, `Couldn't reach "${url.hostname}".`);
    } finally {
      clearTimeout(timeout);
    }

    if (method === "GET" && response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      if (redirects >= MAX_REDIRECTS) throw new GuardedFetchError(502, "Too many redirects.");
      const next = new URL(response.headers.get("location")!, url);
      if (next.protocol !== "http:" && next.protocol !== "https:") {
        throw new GuardedFetchError(400, "Redirected to an unsupported protocol.");
      }
      url = next;
      continue;
    }

    if (!response.ok && throwOnError) throw new GuardedFetchError(502, `Fetch failed with status ${response.status}.`);

    const reader = response.body?.getReader();
    if (!reader) {
      if (throwOnError) throw new GuardedFetchError(502, "Empty response body.");
      return { status: response.status, data: null };
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel();
        throw new GuardedFetchError(413, "Response too large (256KB limit).");
      }
      chunks.push(value);
    }

    const text = Buffer.concat(chunks).toString("utf-8");
    if (!expectJson) return { status: response.status, data: text };
    try {
      return { status: response.status, data: JSON.parse(text) };
    } catch {
      if (throwOnError) throw new GuardedFetchError(422, "Response wasn't valid JSON.");
      return { status: response.status, data: null };
    }
  }
}

/** Thin GET wrapper — kept for existing callers (agent-import) so they don't need to know
 * about the more general POST-capable options. */
export async function fetchPublicJson(rawUrl: string): Promise<unknown> {
  const { data } = await fetchGuarded(rawUrl, { method: "GET" });
  return data;
}
