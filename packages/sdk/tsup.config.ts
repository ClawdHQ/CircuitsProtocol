import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/server.ts"],
  format: ["cjs", "esm"],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  external: ["viem", "@solana/web3.js", "@solana/spl-token", "@coral-xyz/anchor", "@mysten/sui", "@clawdhq/clawmem"],
});
