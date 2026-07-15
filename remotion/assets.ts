import { staticFile } from "remotion";
import { getBuiltinAsset } from "../lib/asset-registry";
import type { ResolvedAsset } from "../lib/resolved";

// Returns a usable src for an asset (image or audio), or null to fall back to a
// drawn placeholder / no audio.
export function srcFor(asset: ResolvedAsset | null | undefined): string | null {
  if (!asset) return null;
  if (asset.src) return asset.src; // uploaded
  if (asset.builtinId) {
    const builtin = getBuiltinAsset(asset.builtinId);
    if (builtin) return staticFile(builtin.publicPath);
  }
  return null;
}
