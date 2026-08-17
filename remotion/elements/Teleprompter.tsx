import { OffthreadVideo, useCurrentFrame } from "remotion";
import type { ResolvedConfig } from "../../lib/resolved";
import {
  FONT_STACK,
  TELEPROMPTER_TEXT_LINE_HEIGHT,
  TELEPROMPTER_TEXT_PADDING_RATIO,
} from "../../lib/constants";

type Tele = ResolvedConfig["content"]["teleprompter"];

export function teleprompterScrollTransform(
  frame: number,
  contentFrames: number,
): { yPercent: number } {
  const progress =
    contentFrames <= 1 ? 0 : Math.max(0, Math.min(1, frame / (contentFrames - 1)));
  return {
    yPercent: progress === 0 ? 0 : -100 * progress,
  };
}

export function Teleprompter(props: {
  tele: Tele;
  screenW: number;
  screenH: number;
  contentFrames: number;
}) {
  if (props.tele.mode === "video") return <TeleVideo tele={props.tele} />;
  return <TeleText {...props} />;
}

function TeleVideo({ tele }: { tele: Tele }) {
  const v = tele.video;
  if (v && !v.asset.builtin && v.asset.src) {
    return (
      <OffthreadVideo
        src={v.asset.src}
        muted={!v.keepAudio}
        style={{ width: "100%", height: "100%", objectFit: "cover" }}
      />
    );
  }
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 24,
        background: "radial-gradient(120% 120% at 50% 40%,#26313f,#0b0e12)",
        color: "#cfe0ff",
        fontFamily: FONT_STACK,
      }}
    >
      <div
        style={{
          width: 150,
          height: 150,
          borderRadius: "50%",
          background: "rgba(255,255,255,.12)",
          border: "3px solid rgba(255,255,255,.25)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 60,
        }}
      >
        ▶
      </div>
      <div style={{ fontSize: 32, opacity: 0.8 }}>上传你的视频</div>
    </div>
  );
}

function TeleText({
  tele,
  screenW,
  screenH,
  contentFrames,
}: {
  tele: Tele;
  screenW: number;
  screenH: number;
  contentFrames: number;
}) {
  const frame = useCurrentFrame();
  const text = tele.text!;

  // Remotion renders neighboring frames concurrently, often in different
  // browser tabs. Reading scrollHeight in an effect made each tab choose its
  // own travel distance, which showed up as alternating jumps in the encoded
  // video. A percentage transform is resolved from the laid-out text box at
  // paint time, so motion is a pure, linear function of the frame number.
  // minHeight keeps short copy deterministic. Translating the complete box by
  // -100% guarantees that every glyph has cleared the screen before the ending
  // Sequence begins on the next frame.
  const { yPercent } = teleprompterScrollTransform(frame, contentFrames);

  return (
    <div style={{ position: "absolute", inset: 0, background: text.bgColor }}>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 0,
          padding: screenW * TELEPROMPTER_TEXT_PADDING_RATIO,
          boxSizing: "border-box",
          minHeight: screenH,
          transform: `translateY(${yPercent}%)`,
          color: text.color,
          fontFamily: FONT_STACK,
          fontWeight: 800,
          fontSize: text.fontSize,
          lineHeight: TELEPROMPTER_TEXT_LINE_HEIGHT,
          textAlign: text.align,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {text.content}
      </div>
    </div>
  );
}
