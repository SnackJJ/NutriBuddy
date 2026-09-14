import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Vitest configuration (issue #99 review finding).
//
// The repository previously ran vitest with no config, which meant the `@/*`
// path alias — declared in tsconfig.json and used throughout `app/` and `src/` —
// did not resolve inside tests. Nothing under `app/` could therefore be imported
// by a test, and the one assertion that needs a route ("a refused request never
// reaches the model") had to be argued structurally instead of executed.
//
// The alias is the only reason this file exists: the exclude list mirrors the
// `npm test` command line so both paths agree, and no globals are enabled —
// tests keep importing `describe`/`it` explicitly, as they already do.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**", "**/.sandcastle/**"],
  },
});
