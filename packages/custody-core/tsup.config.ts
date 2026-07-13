import { defineConfig } from "tsup";

export default defineConfig({
  // skillCatalog is a second, separate entry point (not just re-exported from index.ts) because
  // it's the one piece of this package pure/data-only enough to be safely imported from a
  // browser bundle — apps/web's useSkills.ts ("use client") needs it, and index.ts's main
  // barrel pulls in Node-only built-ins (dns/promises, net, etc. via guardedFetch.ts) that can't
  // resolve in a browser. Consumers that are fine with the full Node-only surface (this
  // package's other exports, and packages/hosted-agent-runtime) can still import it from here.
  entry: ["src/index.ts", "src/skillCatalog.ts"],
  format: ["cjs", "esm"],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  external: ["@clawdhq/custody-db", "@clawdhq/sdk", "viem", "@solana/web3.js", "@solana/spl-token", "@coral-xyz/anchor", "@mysten/sui", "bs58"],
});
