import * as esbuild from "esbuild";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";

function serveUrls(hosts, port) {
  const names = new Set(
    (hosts?.length ? hosts : ["127.0.0.1"]).flatMap((host) => {
      if (host === "0.0.0.0" || host === "::") return ["127.0.0.1"];
      return [host.includes(":") ? `[${host}]` : host];
    }),
  );

  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.internal || net.family !== "IPv4") continue;
      names.add(net.address);
    }
  }

  return [...names].map((host) => `http://${host}:${port}`);
}

const isServe = process.argv.includes("--serve");

function packZip() {
  execFile(process.execPath, ["./pack-zip.js"], (err, stdout) => {
    if (err) {
      console.error("Error packing zip:", err);
      return;
    }
    console.log(stdout.trim());
  });
}

const zipPlugin = {
  name: "zip-plugin",
  setup(build) {
    build.onEnd(() => {
      packZip();
    });
  },
};

const portableNodeGuard = {
  name: "portable-node-guard",
  setup(build) {
    // pi-ai's browser-safe provider env helper retains a Bun-only node:fs
    // fallback behind a runtime guard. Replace that unreachable fallback so
    // the shipped WebView bundle has no external Node dependency at all.
    build.onResolve({ filter: /^node:fs$/ }, () => ({
      path: "node:fs",
      namespace: "portable-node-stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "portable-node-stub" }, () => ({
      contents: 'export function readFileSync() { throw new Error("Node filesystem is unavailable in the portable agent runtime"); }',
      loader: "js",
    }));
    build.onResolve({ filter: /^node:/ }, (args) => ({
      errors: [{ text: `Node runtime dependency is forbidden: ${args.path}` }],
    }));
  },
};

const minifiedCssText = {
  name: "minified-css-text",
  setup(build) {
    build.onLoad({ filter: /\.css$/ }, async ({ path }) => {
      const source = await fs.readFile(path, "utf8");
      const { code } = await esbuild.transform(source, { loader: "css", minify: true });
      return { contents: `export default ${JSON.stringify(code)}`, loader: "js" };
    });
  },
};

const buildConfig = {
  entryPoints: {
    main: "src/main.ts",
    "diff-view": "src/ui/diffViewRuntime.ts",
  },
  bundle: true,
  minify: true,
  platform: "browser",
  target: ["chrome90"],
  format: "iife",
  jsx: "automatic",
  jsxImportSource: "preact",
  logLevel: "info",
  color: true,
  metafile: true,
  outdir: "dist",
  loader: {
    ".css": "text",
  },
  plugins: [portableNodeGuard, minifiedCssText, zipPlugin],
};

(async function () {
  if (isServe) {
    console.log("Starting development server...");

    const ctx = await esbuild.context(buildConfig);
    await ctx.watch();
    const { hosts, port } = await ctx.serve({
      servedir: ".",
      port: 3000,
    });
    for (const url of serveUrls(hosts, port)) {
      console.log(`Development server: ${url}`);
    }
  } else {
    console.log("Building for production...");
    const result = await esbuild.build(buildConfig);
    const output = result.metafile.outputs["dist/main.js"];
    const externalImports = Object.values(result.metafile.outputs).flatMap((entry) => entry.imports.filter((item) => item.external));
    if (externalImports.length) {
      throw new Error(`Portable bundle has external runtime imports: ${externalImports.map((entry) => entry.path).join(", ")}`);
    }
    if ((output?.bytes ?? 0) > 1_900_000) {
      throw new Error(`AI bundle exceeds the 1.90 MB mobile budget: ${output.bytes} bytes`);
    }
    console.log("Production build complete.");
  }
})();
