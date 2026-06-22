import { Img, useCurrentFrame, useVideoConfig } from "remotion";
import type { ResolvedConfig } from "../../lib/resolved";
import { deviceBox } from "../../lib/coords";
import { srcFor } from "../assets";
import { entranceAnim } from "../anim";
import { Teleprompter } from "./Teleprompter";

export function Device({
  device,
  teleprompter,
  contentFrames,
}: {
  device: ResolvedConfig["content"]["device"];
  teleprompter: ResolvedConfig["content"]["teleprompter"];
  contentFrames: number;
}) {
  const b = deviceBox(device);
  const src = srcFor(device.asset);
  const screen = teleprompter.screen;
  const screenW = b.width * screen.w;
  const screenH = b.height * screen.h;

  // Small entrance when the main content begins (frame resets to 0 here because
  // the Content scene is a Sequence). The teleprompter leads, the mic follows.
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = entranceAnim(frame, fps, { fromScale: 0.94, rise: 16 });

  return (
    <div
      style={{
        position: "absolute",
        left: b.left,
        top: b.top,
        width: b.width,
        height: b.height,
        opacity: enter.opacity,
        transform: `translateY(${enter.translateY}px) rotate(${device.rotation}deg) scale(${enter.scale})`,
        transformOrigin: "center",
      }}
    >
      {src ? (
        <Img
          src={src}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain" }}
        />
      ) : (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "#0b0b0e",
            borderRadius: b.width * 0.13,
            boxShadow: "0 36px 70px rgba(0,0,0,.55), inset 0 0 0 7px #2a2a30",
          }}
        />
      )}

      {/* teleprompter screen — sits on top of the device image's black screen */}
      <div
        style={{
          position: "absolute",
          left: screen.x * b.width,
          top: screen.y * b.height,
          width: screenW,
          height: screenH,
          overflow: "hidden",
          borderRadius: b.width * 0.04,
          background: "#000",
        }}
      >
        <Teleprompter
          tele={teleprompter}
          screenW={screenW}
          screenH={screenH}
          contentFrames={contentFrames}
        />
      </div>
    </div>
  );
}
