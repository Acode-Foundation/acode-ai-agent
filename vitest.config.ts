import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Mirrors the tsconfig path: the package's exports map does not expose the prelude.
      "pi-codemode-internal/prelude": fileURLToPath(
        new URL(
          "./node_modules/@earendil-works/pi-codemode/dist/runtime/prelude-source.js",
          import.meta.url,
        ),
      ),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
