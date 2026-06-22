// Builds the Remotion composition into a static site and places it under
// public/remotion-site so the deployment (Vercel) hosts it. The desktop
// renderer points its headless Chromium at this hosted site as `serveUrl`,
// which is why the desktop app never needs the composition source bundled.
//
// Served at the "/remotion-site/" sub-path, so publicPath must match.
import { bundle } from "@remotion/bundler";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entryPoint = path.join(root, "remotion", "index.ts");
const publicDir = path.join(root, "public");
const dest = path.join(publicDir, "remotion-site");

// Remove any previous output first so it isn't copied into the fresh bundle.
await fs.rm(dest, { recursive: true, force: true });

let lastLogged = -1;
const outDir = await bundle({
  entryPoint,
  publicDir,
  publicPath: "/remotion-site/",
  onProgress: (progress) => {
    if (progress >= lastLogged + 10) {
      lastLogged = progress;
      console.log(`  bundling… ${progress}%`);
    }
  },
});

await fs.cp(outDir, dest, { recursive: true });
console.log(`✓ Remotion site → public/remotion-site (served at /remotion-site/)`);
