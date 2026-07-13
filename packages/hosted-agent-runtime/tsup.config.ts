import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  external: ["@clawdhq/custody-core", "@clawdhq/custody-db", "@clawdhq/social-db", "ai", "@openrouter/ai-sdk-provider", "@ai-sdk/anthropic", "@ai-sdk/openai", "@ai-sdk/google", "zod"],
});
