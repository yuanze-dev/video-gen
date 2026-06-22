import { Img, useCurrentFrame, useVideoConfig } from "remotion";
import type { ResolvedConfig } from "../../lib/resolved";
import { deviceBox } from "../../lib/coords";
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
      {/* device graphic */}
      {!device.asset.builtin && device.asset.src ? (
        <Img
          src={device.asset.src}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain" }}
        />
      ) : (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "#0b0b0e",
            borderRadius: b.width * 0.13,
            boxShadow: "0 36px 70px rgba(0,0,0,.55), inset 0 0 0 7px #2a2a30, 0 0 0 4px #000",
          }}
        >
          <div
            style={{
              position: "absolute",
              top: b.height * 0.025,
              left: "50%",
              transform: "translateX(-50%)",
              width: b.width * 0.28,
              height: b.height * 0.018,
              background: "#000",
              borderRadius: 999,
              zIndex: 3,
            }}
          />
        </div>
      )}

      {/* teleprompter screen */}
      <div
        style={{
          position: "absolute",
          left: screen.x * b.width,
          top: screen.y * b.height,
          width: screenW,
          height: screenH,
          overflow: "hidden",
          borderRadius: b.width * 0.08,
          background: "#000",
          zIndex: 2,
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
