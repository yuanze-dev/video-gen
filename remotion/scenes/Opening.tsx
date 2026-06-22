import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { Background } from "../elements/Background";
import { Title } from "../elements/Title";
import { Countdown } from "../elements/Countdown";
import { Curtain } from "../elements/Curtain";
import type { ResolvedConfig } from "../../lib/resolved";

export function Opening({ config }: { config: ResolvedConfig }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const cd = config.opening.countdown;
  // Curtain opens across the whole opening, concurrent with the countdown.
  const openingDur = cd.enabled ? cd.from / cd.speed : config.opening.curtain.openDurationSec;
  const titleOpacity = interpolate(
    frame,
    [openingDur * 0.5 * fps, openingDur * fps],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  return (
    <AbsoluteFill>
      <Background asset={config.content.background} />
      <Title title={config.opening.title} opacity={titleOpacity} />
      {cd.enabled && <Countdown from={cd.from} speed={cd.speed} x={cd.x} y={cd.y} />}
      <Curtain color={config.opening.curtain.color} startSec={0} openDurationSec={openingDur} />
    </AbsoluteFill>
  );
}
