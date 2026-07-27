import { defineConfig } from "tsup";

export default defineConfig({
  // skillCatalog and llmModelCatalog are separate entry points (not just re-exported from
  // index.ts) because they're the pieces of this package pure/data-only enough to be safely
  // imported from a browser bundle — apps/web's useSkills.ts / foundationModels.ts ("use client")
  // need them, and index.ts's main barrel pulls in Node-only built-ins (dns/promises, net, etc.
  // via guardedFetch.ts) that can't resolve in a browser. Consumers that are fine with the full
  // Node-only surface (this package's other exports, and packages/hosted-agent-runtime) can still
  // import them from here.
  entry: ["src/index.ts", "src/skillCatalog.ts", "src/llmModelCatalog.ts"],
  format: ["cjs", "esm"],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  external: ["@clawdhq/circle", "@clawdhq/custody-db", "@clawdhq/sdk", "viem", "@solana/web3.js", "@solana/spl-token", "@coral-xyz/anchor", "@mysten/sui", "bs58"],
});
