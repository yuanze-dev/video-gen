import { AbsoluteFill, OffthreadVideo } from "remotion";
import {
  DEFAULT_ENDING_ASSET_ID,
  DEFAULT_ENDING_DURATION_SEC,
} from "../../lib/config-schema";
import type { ResolvedConfig } from "../../lib/resolved";
import { srcFor } from "../assets";

export function Ending({ config }: { config: ResolvedConfig }) {
  // Remote Remotion code can be driven by an older installed Electron shell
  // whose bundled resolver predates `ending`. Keep the default outro renderable
  // in that mixed-version window; custom replacements are capability-gated by
  // the editor before export.
  const video = config.ending?.video ?? {
    asset: {
      builtin: true,
      src: null,
      builtinId: DEFAULT_ENDING_ASSET_ID,
      durationSec: DEFAULT_ENDING_DURATION_SEC,
    },
    keepAudio: true,
  };
  const src = srcFor(video.asset);

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {src ? (
        <OffthreadVideo
          src={src}
          muted={!video.keepAudio}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : null}
    </AbsoluteFill>
  );
}
