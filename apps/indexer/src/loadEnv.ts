import { config } from "dotenv";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Resolved relative to this file's own location, not process.cwd() — pnpm/turbo run each
// workspace package's scripts with cwd set to the package directory (apps/indexer), so a bare
// `dotenv/config` silently finds nothing there and every var reads as undefined. The repo keeps
// one shared `.env` at the monorepo root (see .env.example), not a per-package copy. Import this
// module first, for its side effect, in any entrypoint that reads process.env.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
config({ path: resolve(repoRoot, ".env") });

// Layer apps/web/.env.local on top, overriding, mirroring Next.js's own .env.local > .env
// precedence. Local dev points apps/web at a local Hardhat node via NEXT_PUBLIC_*_RPC_URL/
// *_CONTRACT_ADDRESS overrides in that file (real public testnet RPCs aren't reachable from
// every sandbox); without loading it too, this process would watch/sign against a different
// chain than whatever apps/web's UI is actually using. No-ops if the file doesn't exist (e.g.
// production, or a dev machine that hasn't set up a local devnet).
const webEnvLocal = resolve(repoRoot, "apps/web/.env.local");
if (existsSync(webEnvLocal)) config({ path: webEnvLocal, override: true });
