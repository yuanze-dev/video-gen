import type { ResolvedConfig } from "../../lib/resolved";
import { CANVAS, FONT_STACK } from "../../lib/constants";

export function Title({
  title,
  opacity = 1,
}: {
  title: ResolvedConfig["opening"]["title"];
  opacity?: number;
}) {
  return (
    <div
      style={{
        position: "absolute",
        left: title.x * CANVAS.width,
        top: title.y * CANVAS.height,
        transform: "translate(-50%, -50%)",
        width: CANVAS.width * 0.84,
        textAlign: "center",
        fontFamily: FONT_STACK,
        fontWeight: 900,
        fontSize: title.fontSize,
        lineHeight: 1.15,
        color: title.color,
        WebkitTextStroke: title.stroke ? "4px #000" : undefined,
        paintOrder: "stroke fill",
        textShadow: "0 8px 18px rgba(0,0,0,.6)",
        zIndex: 30,
        opacity,
      }}
    >
      {title.text}
    </div>
  );
}
