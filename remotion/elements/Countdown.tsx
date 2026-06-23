import { useCurrentFrame, useVideoConfig } from "remotion";
import { CANVAS, FONT_STACK } from "../../lib/constants";

// Shows from, from-1, ... 1 over the first `from / speed` seconds, then disappears.
// `speed` is a tick-rate multiplier: >1 counts down faster, <1 slower.
export function Countdown({
  from,
  speed = 1,
  fontSize = 170,
  x = 0.5,
  y = 0.72,
}: {
  from: number;
  speed?: number;
  fontSize?: number;
  x?: number;
  y?: number;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const sec = (frame / fps) * speed;
  if (sec >= from) return null;
  const n = from - Math.floor(sec);

  return (
    <div
      style={{
        position: "absolute",
        left: x * CANVAS.width,
        top: y * CANVAS.height,
        transform: "translate(-50%, -50%)",
        fontFamily: FONT_STACK,
        fontWeight: 900,
        fontSize,
        color: "#fff",
        WebkitTextStroke: "5px #000",
        paintOrder: "stroke fill",
        textShadow: "0 10px 30px rgba(0,0,0,.6)",
        zIndex: 30,
      }}
    >
      {n}
    </div>
  );
}
