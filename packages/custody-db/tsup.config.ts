import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  // Declarations are emitted separately via `tsc --emitDeclarationOnly` (see package.json's
  // build script) — tsup's own dts bundler (rollup-plugin-dts) can't parse the `import X =
  // Y.Z` syntax Prisma's generated runtime types use and hard-crashes on it. Plain tsc
  // handles that syntax natively.
  dts: false,
  splitting: false,
  sourcemap: true,
  clean: true,
  // Keep the generated Prisma client (custom `output` — see prisma/schema.prisma) out of the
  // bundle: it ships a native query-engine binary that must stay a real file on disk, not
  // get inlined into a single JS bundle. package.json's build script copies
  // src/generated -> dist/generated so this reference still resolves at runtime.
  external: ["@prisma/client", /generated\/prisma\/client\.js$/],
});
