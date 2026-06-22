import { staticFile } from "remotion";
import type { ResolvedAsset } from "../lib/resolved";

// Built-in asset id -> file under /public. Resolved via staticFile so it works
// in both the editor Player and the server renderer.
const BUILTIN_FILES: Record<string, string> = {
  airport: "assets/builtin/airport.jpg",
  mic: "assets/builtin/microphone.png",
  "open-sfx": "assets/builtin/open-sfx.mp3",
  "airport-bgm": "assets/builtin/airport-bgm.mp3",
};

// Returns a usable src for an asset (image or audio), or null to fall back to a
// drawn placeholder / no audio.
export function srcFor(asset: ResolvedAsset | null | undefined): string | null {
  if (!asset) return null;
  if (asset.src) return asset.src; // uploaded
  if (asset.builtinId && BUILTIN_FILES[asset.builtinId]) {
    return staticFile(BUILTIN_FILES[asset.builtinId]);
  }
  return null;
}
