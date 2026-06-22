import { Composition } from "remotion";
import { TeleprompterVideo } from "./TeleprompterVideo";
import { defaultResolvedConfig } from "./default";
import { totalFrames } from "../lib/duration";
import type { ResolvedConfig } from "../lib/resolved";

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="Teleprompter"
      component={TeleprompterVideo}
      durationInFrames={300}
      fps={defaultResolvedConfig.canvas.fps}
      width={defaultResolvedConfig.canvas.width}
      height={defaultResolvedConfig.canvas.height}
      defaultProps={{ config: defaultResolvedConfig as ResolvedConfig }}
      calculateMetadata={({ props }) => {
        const cfg = props.config as ResolvedConfig;
        return { durationInFrames: totalFrames(cfg), fps: cfg.canvas.fps };
      }}
    />
  );
};
