import { http, type HttpTransportConfig, type Transport } from "viem";

// Arc Testnet's public RPC (https://rpc.testnet.arc.network) enforces a hard 1 request/second
// limit and signals it with JSON-RPC error code -32011 ("request limit reached") — sometimes
// under an HTTP 429 status, sometimes under a plain HTTP 200 with the error embedded in the
// body (observed both from the same endpoint). viem's `http()` transport only exposes
// `retryCount`/`retryDelay` as *counts*, not a way to customize *which* errors are retryable —
// its internal `shouldRetry` only retries HTTP status 429 or JSON-RPC error code exactly 429,
// so code -32011 silently never retries no matter how `retryCount`/`retryDelay` are set. This
// wraps `http()` with an outer retry loop that specifically recognizes -32011 (in addition to
// whatever `http()` itself already retries), confirmed empirically to actually recover calls
// that the built-in retry does not.
const RATE_LIMIT_CODES = new Set([-32011]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(err: unknown): boolean {
  let cause: unknown = err;
  for (let depth = 0; depth < 8 && cause; depth++) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "number" && RATE_LIMIT_CODES.has(code)) return true;
    cause = (cause as { cause?: unknown }).cause;
  }
  return false;
}

export interface RateLimitRetryOptions {
  /** Max extra attempts after the first, specifically for -32011 errors. @default 5 */
  retryAttempts?: number;
  /** Base delay in ms, scaled linearly by attempt number (1x, 2x, 3x, ...). @default 1000 */
  retryDelayMs?: number;
}

/** `http()` transport that also retries on Arc Testnet's -32011 rate-limit error — see the
 * module doc comment above for why `http()`'s own `retryCount`/`retryDelay` don't cover this. */
export function httpWithRateLimitRetry(url: string, httpConfig?: HttpTransportConfig, retryOptions?: RateLimitRetryOptions): Transport {
  const retryAttempts = retryOptions?.retryAttempts ?? 5;
  const retryDelayMs = retryOptions?.retryDelayMs ?? 1000;
  const base = http(url, httpConfig);

  return (params) => {
    const transport = base(params);
    const request: typeof transport.request = async (...args) => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await transport.request(...args);
        } catch (err) {
          if (!isRateLimitError(err) || attempt >= retryAttempts) throw err;
          await sleep(retryDelayMs * (attempt + 1));
        }
      }
    };
    return { ...transport, request };
  };
}
