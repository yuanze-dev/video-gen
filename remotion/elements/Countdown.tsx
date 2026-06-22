import { useCurrentFrame, useVideoConfig } from "remotion";
import { CANVAS, FONT_STACK } from "../../lib/constants";

// Shows from, from-1, ... 1 over the first `from` seconds, then disappears.
export function Countdown({ from }: { from: number }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const sec = frame / fps;
  if (sec >= from) return null;
  const n = from - Math.floor(sec);

  return (
    <div
      style={{
        position: "absolute",
        left: CANVAS.width / 2,
        top: CANVAS.height * 0.72,
        transform: "translate(-50%, -50%)",
        fontFamily: FONT_STACK,
        fontWeight: 900,
        fontSize: 170,
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
