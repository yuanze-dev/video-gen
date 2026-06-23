// Downloads Remotion's headless Chromium (chrome-headless-shell) into
// node_modules/.remotion so electron-builder can bundle it (see extraResources
// in electron-builder.yml). Needed in CI, where it isn't present after a fresh
// install. Locally it's downloaded lazily on first render.
const { ensureBrowser } = await import("@remotion/renderer");
const status = await ensureBrowser();
console.log("✓ chrome-headless-shell ready:", JSON.stringify(status));
