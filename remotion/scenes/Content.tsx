import { AbsoluteFill } from "remotion";
import { Background } from "../elements/Background";
import { Device } from "../elements/Device";
import { Mic } from "../elements/Mic";
import { contentFrames } from "../../lib/duration";
import type { ResolvedConfig } from "../../lib/resolved";

export function Content({ config }: { config: ResolvedConfig }) {
  const cf = contentFrames(config);
  return (
    <AbsoluteFill>
      <Background asset={config.content.background} />
      <Device
        device={config.content.device}
        teleprompter={config.content.teleprompter}
        contentFrames={cf}
      />
      <Mic mic={config.content.mic} />
    </AbsoluteFill>
  );
}
