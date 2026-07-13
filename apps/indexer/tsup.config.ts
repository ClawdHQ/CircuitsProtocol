import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts", "src/scheduler.ts", "src/hostedRuntimeScheduler.ts"],
  format: ["esm"],
  splitting: false,
  sourcemap: true,
  clean: true,
  noExternal: [],
});
