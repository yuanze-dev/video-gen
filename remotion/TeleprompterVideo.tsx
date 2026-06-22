import { AbsoluteFill, Sequence, Html5Audio } from "remotion";
import { Opening } from "./scenes/Opening";
import { Content } from "./scenes/Content";
import { openingFrames } from "../lib/duration";
import { srcFor } from "./assets";
import type { ResolvedConfig } from "../lib/resolved";

export function TeleprompterVideo({ config }: { config: ResolvedConfig }) {
  const openF = openingFrames(config);
  const bgm = config.content.bgm;
  const sfxSrc = srcFor(config.opening.sfx);
  const bgmSrc = bgm ? srcFor(bgm.asset) : null;

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      <Sequence durationInFrames={openF}>
        <Opening config={config} />
      </Sequence>
      <Sequence from={openF}>
        <Content config={config} />
      </Sequence>

      {/* opening sound effect — plays from the very start */}
      {sfxSrc ? <Html5Audio src={sfxSrc} /> : null}

      {/* content background music — loops across the content section */}
      {bgmSrc ? (
        <Sequence from={openF}>
          <Html5Audio src={bgmSrc} volume={bgm!.volume} loop />
        </Sequence>
      ) : null}
    </AbsoluteFill>
  );
}
