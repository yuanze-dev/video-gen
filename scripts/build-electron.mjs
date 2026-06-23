// Compiles the Electron main + preload TypeScript into CommonJS bundles under
// electron/dist. @remotion/renderer is kept external and loaded via dynamic
// import() at runtime (it ships native compositor binaries that must not be
// bundled); electron is provided by the runtime.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

await build({
  entryPoints: [
    path.join(root, "electron/main.ts"),
    path.join(root, "electron/preload.ts"),
  ],
  outdir: path.join(root, "electron/dist"),
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: true,
  // Native / runtime-resolved packages stay in node_modules and are required
  // (or dynamically imported) at runtime, not inlined into the bundle.
  // electron-updater is kept external too: it reads app-update.yml from the
  // packaged resources at runtime and pulls in builder-util-runtime; bundling it
  // is fragile, so resolve it from node_modules (it's a production dep, so
  // electron-builder packs it into the asar).
  external: ["electron", "@remotion/renderer", "electron-updater"],
  logLevel: "info",
});

console.log("✓ electron main/preload compiled → electron/dist");
