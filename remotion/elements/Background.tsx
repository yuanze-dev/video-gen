import { AbsoluteFill, Img } from "remotion";
import type { ResolvedAsset } from "../../lib/resolved";
import { srcFor } from "../assets";

const AIRPORT =
  "radial-gradient(60% 38% at 50% 6%, rgba(255,221,170,.55), transparent 70%)," +
  "linear-gradient(180deg,#d9c39a 0%,#e7d5ac 26%,#b7c3cf 27%,#9fb0bd 33%,#8b97a0 49%,#6f6457 50%,#5a4f43 70%,#3c332a 100%)";

export function Background({ asset }: { asset: ResolvedAsset }) {
  const src = srcFor(asset);
  if (src) {
    return (
      <AbsoluteFill>
        <Img src={src} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      </AbsoluteFill>
    );
  }
  // Built-in placeholder: a stylised airport gate.
  return (
    <AbsoluteFill style={{ background: AIRPORT }}>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 0,
          height: "27%",
          background:
            "repeating-linear-gradient(90deg,transparent 0 86px,rgba(255,255,255,.16) 86px 94px)," +
            "repeating-linear-gradient(0deg,rgba(255,255,255,.05) 0 24px,transparent 24px 64px)",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: "40%",
          height: "22%",
          background:
            "radial-gradient(40px 86px at 12% 70%,#2c2620cc,transparent 70%)," +
            "radial-gradient(36px 74px at 24% 78%,#322a22cc,transparent 70%)," +
            "radial-gradient(46px 96px at 78% 64%,#241f19cc,transparent 70%)," +
            "radial-gradient(36px 80px at 89% 74%,#2c2620cc,transparent 70%)",
        }}
      />
    </AbsoluteFill>
  );
}
