import { spring } from "remotion";

export type Entrance = { opacity: number; scale: number; translateY: number };

type EntranceOpts = {
  /** Frames to wait before this layer starts animating in (at the comp fps). */
  delay?: number;
  /** Add a gentle overshoot for a livelier "pop". */
  bounce?: boolean;
  /** Scale to start from (1 = no scaling). */
  fromScale?: number;
  /** Pixels below the resting position to start from (slides up to 0). */
  rise?: number;
};

// A small, tasteful entrance for content-scene layers (device + mic): a quick
// fade + scale-up + slide that plays once when the main content begins. The
// returned pieces are composed into each element's own transform string so the
// existing rotation/flip transforms are preserved.
export function entranceAnim(
  frame: number,
  fps: number,
  { delay = 0, bounce = false, fromScale = 0.92, rise = 0 }: EntranceOpts = {},
): Entrance {
  const progress = spring({
    frame: frame - delay,
    fps,
    config: bounce
      ? { damping: 13, mass: 0.6, stiffness: 170 }
      : { damping: 30, mass: 0.5, stiffness: 130 },
  });
  return {
    opacity: Math.min(1, Math.max(0, progress)),
    // progress may briefly exceed 1 when bouncing — let scale/translate ride the
    // overshoot for life, but keep opacity clamped.
    scale: fromScale + (1 - fromScale) * progress,
    translateY: rise * (1 - progress),
  };
}
