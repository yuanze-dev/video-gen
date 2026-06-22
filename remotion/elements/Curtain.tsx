import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, Easing } from "remotion";

// Velvet folds + sheen, built from layered gradients (no physics, no libs).
// Driven entirely by the current frame so preview === render.
function panelBackground(color: string): string {
  return [
    "linear-gradient(90deg,rgba(0,0,0,.45),rgba(0,0,0,0) 8%,rgba(255,255,255,.06) 16%,rgba(0,0,0,0) 26%)",
    "repeating-linear-gradient(90deg,rgba(255,255,255,.12) 0,rgba(255,255,255,.02) 22px,rgba(0,0,0,.32) 52px,rgba(0,0,0,.04) 82px,rgba(255,255,255,.12) 104px)",
    "linear-gradient(180deg,rgba(255,255,255,.14),rgba(0,0,0,0) 18%,rgba(0,0,0,.30) 100%)",
    color,
  ].join(",");
}

function Panel({
  side,
  progress,
  color,
}: {
  side: "l" | "r";
  progress: number;
  color: string;
}) {
  const sign = side === "l" ? -1 : 1;
  return (
    <div
      style={{
        position: "absolute",
        top: "-2%",
        bottom: "-2%",
        width: "55%",
        [side === "l" ? "left" : "right"]: 0,
        background: panelBackground(color),
        boxShadow: "inset 0 0 50px rgba(0,0,0,.45)",
        transformOrigin: side === "l" ? "left center" : "right center",
        // Pure translate → GPU-composited, no per-frame re-rasterization.
        transform: `translateX(${sign * 104 * progress}%)`,
        willChange: "transform",
        borderRight: side === "l" ? "4px solid rgba(0,0,0,.35)" : undefined,
        borderLeft: side === "r" ? "4px solid rgba(0,0,0,.35)" : undefined,
      }}
    />
  );
}

export function Curtain({
  color,
  startSec,
  openDurationSec,
}: {
  color: string;
  startSec: number;
  openDurationSec: number;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const progress = interpolate(
    frame,
    [startSec * fps, (startSec + openDurationSec) * fps],
    [0, 1],
    // Near-linear with a gentle ease at both ends, so the curtain keeps moving
    // across the whole countdown and finishes opening exactly at zero.
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.45, 0, 0.55, 1) },
  );

  return (
    <AbsoluteFill style={{ zIndex: 6, pointerEvents: "none" }}>
      <Panel side="l" progress={progress} color={color} />
      <Panel side="r" progress={progress} color={color} />
      {/* valance / pelmet */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 120,
          background: panelBackground(color),
          boxShadow: "0 16px 30px rgba(0,0,0,.5)",
          zIndex: 2,
        }}
      />
    </AbsoluteFill>
  );
}
