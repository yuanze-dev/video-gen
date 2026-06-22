import { Img } from "remotion";
import type { ResolvedConfig } from "../../lib/resolved";
import { micBox } from "../../lib/coords";
import { srcFor } from "../assets";

export function Mic({ mic }: { mic: ResolvedConfig["content"]["mic"] }) {
  const b = micBox(mic);
  const style: React.CSSProperties = {
    position: "absolute",
    left: b.left,
    top: b.top,
    width: b.width,
    height: b.height,
    transform: `rotate(${mic.rotation}deg)`,
    transformOrigin: "center",
    filter: "drop-shadow(0 18px 30px rgba(0,0,0,.5))",
  };
  const src = srcFor(mic.asset);
  if (src) {
    return <Img src={src} style={{ ...style, objectFit: "contain" }} />;
  }
  return (
    <div style={style}>
      <svg viewBox="0 0 120 150" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">
        <rect x="86" y="0" width="14" height="22" rx="6" fill="#222" />
        <rect x="60" y="14" width="50" height="12" rx="6" fill="#1a1a1a" transform="rotate(28 85 20)" />
        <ellipse cx="52" cy="74" rx="34" ry="40" fill="#111" />
        <ellipse cx="52" cy="62" rx="30" ry="30" fill="#3a3a3a" />
        <ellipse cx="52" cy="62" rx="30" ry="30" fill="url(#grille)" />
        <rect x="40" y="100" width="24" height="46" rx="9" fill="#181818" />
        <defs>
          <pattern id="grille" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(20)">
            <circle cx="2" cy="2" r="1.3" fill="#555" />
          </pattern>
        </defs>
      </svg>
    </div>
  );
}
