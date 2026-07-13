import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  external: [
    "viem",
    "@solana/web3.js",
    "@circle-fin/adapter-solana",
    "@circle-fin/adapter-viem-v2",
    "@circle-fin/bridge-kit",
    "@circle-fin/developer-controlled-wallets",
    "@circle-fin/provider-cctp-v2",
    "@circle-fin/user-controlled-wallets",
  ],
});
