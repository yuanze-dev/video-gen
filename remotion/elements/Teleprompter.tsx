import { useEffect, useRef, useState } from "react";
import { OffthreadVideo, useCurrentFrame, delayRender, continueRender } from "remotion";
import type { ResolvedConfig } from "../../lib/resolved";
import { FONT_STACK } from "../../lib/constants";

type Tele = ResolvedConfig["content"]["teleprompter"];

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
  const ref = useRef<HTMLDivElement>(null);
  const [textH, setTextH] = useState<number | null>(null);
  const [handle] = useState(() => delayRender("measure-teleprompter"));

  useEffect(() => {
    if (ref.current) {
      setTextH(ref.current.scrollHeight);
      continueRender(handle);
    }
  }, [handle]);

  const distance = textH ? Math.max(0, textH - screenH) + screenH * 0.45 : 0;
  const progress = contentFrames <= 1 ? 0 : Math.min(1, frame / (contentFrames - 1));
  const y = -distance * progress;

  return (
    <div style={{ position: "absolute", inset: 0, background: text.bgColor }}>
      <div
        ref={ref}
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 0,
          padding: screenW * 0.07,
          transform: `translateY(${y}px)`,
          color: text.color,
          fontFamily: FONT_STACK,
          fontWeight: 800,
          fontSize: text.fontSize,
          lineHeight: 1.2,
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
