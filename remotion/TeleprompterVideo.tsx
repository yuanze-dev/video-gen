import { AbsoluteFill, Sequence, Html5Audio } from "remotion";
import { Opening } from "./scenes/Opening";
import { Content } from "./scenes/Content";
import { Ending } from "./scenes/Ending";
import { contentFrames, endingFrames, openingFrames } from "../lib/duration";
import { srcFor } from "./assets";
import type { ResolvedConfig } from "../lib/resolved";

export function TeleprompterVideo({ config }: { config: ResolvedConfig }) {
  const openF = openingFrames(config);
  const contentF = contentFrames(config);
  const endF = endingFrames(config);
  const endingStart = openF + contentF;
  const premountF = config.canvas.fps;
  const bgm = config.content.bgm;
  const sfxSrc = srcFor(config.opening.sfx);
  const bgmSrc = bgm ? srcFor(bgm.asset) : null;

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      <Sequence durationInFrames={openF} premountFor={premountF}>
        <Opening config={config} />
      </Sequence>
      <Sequence
        from={openF}
        durationInFrames={contentF}
        premountFor={premountF}
      >
        <Content config={config} />
      </Sequence>
      <Sequence
        from={endingStart}
        durationInFrames={endF}
        premountFor={premountF}
      >
        <Ending config={config} />
      </Sequence>

      {/* opening sound effect — starts immediately but can never leak into ending */}
      {sfxSrc ? (
        <Sequence durationInFrames={endingStart} premountFor={premountF}>
          <Html5Audio src={sfxSrc} />
        </Sequence>
      ) : null}

      {/* content background music — loops across the content section */}
      {bgmSrc ? (
        <Sequence
          from={openF}
          durationInFrames={contentF}
          premountFor={premountF}
        >
          <Html5Audio src={bgmSrc} volume={bgm!.volume} loop />
        </Sequence>
      ) : null}
    </AbsoluteFill>
  );
}
