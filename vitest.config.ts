import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  define: {
    ELO_PUBLISHER_ID: '"test-publisher"',
    ELO_AD_UNIT_ID: '"test-unit"',
    ELO_IOS_AD_UNIT_ID: '""',
  },
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
    // Elo's browser ESM uses extensionless relative imports, resolved by esbuild in production.
    server: { deps: { inline: ["@elo-ads/web-sdk"] } },
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
