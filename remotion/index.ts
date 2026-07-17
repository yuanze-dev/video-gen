import { cancelRender, continueRender, delayRender, registerRoot } from "remotion";
import "@fontsource-variable/noto-sans-sc";
import { RemotionRoot } from "./Root";

// Fontsource is bundled locally, but the browser still resolves the WOFF2
// asynchronously. Hold the first frame until the exact packaged font is ready
// so cold and warm renders remain pixel-identical.
const fontHandle = delayRender("等待内置 Noto Sans SC 字体");
if (typeof document === "undefined" || !document.fonts) {
  continueRender(fontHandle);
} else {
  void document.fonts.ready
    .then(() => continueRender(fontHandle))
    .catch((error: unknown) => cancelRender(error));
}

// Entry point bundled by @remotion/bundler for server-side rendering.
registerRoot(RemotionRoot);
