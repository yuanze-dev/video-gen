import { z } from "zod";
import { CANVAS } from "./constants";

// All spatial values are normalized 0..1 relative to the canvas, so the small
// editor preview and the 1080x1920 render are equivalent.

export const Point = z.object({ x: z.number(), y: z.number() });

export const Transform = z.object({
  x: z.number(), // normalized center X
  y: z.number(), // normalized center Y
  scale: z.number().min(0.2).max(3).default(1),
  rotation: z.number().default(0), // degrees
  flipH: z.boolean().default(false), // mirror horizontally
  flipV: z.boolean().default(false), // mirror vertically
});

// Inset rectangle (fractions 0..1) of the device box that acts as the
// teleprompter "screen". Content (text or video) is clipped to this region.
export const ScreenRect = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
});

export const AssetRef = z.object({
  kind: z.enum(["builtin", "upload"]),
  id: z.string(),
  mime: z.string().optional(),
  durationSec: z.number().optional(),
});
export type AssetRef = z.infer<typeof AssetRef>;

export const ProjectConfig = z.object({
  version: z.literal(1),
  canvas: z.object({
    width: z.literal(1080),
    height: z.literal(1920),
    fps: z.literal(60),
  }),

  opening: z.object({
    title: z.object({
      text: z.string().max(160),
      fontSize: z.number().default(96), // canvas px
      color: z.string().default("#ffffff"),
      stroke: z.boolean().default(true),
      pos: Point,
    }),
    countdown: z.object({
      enabled: z.boolean().default(true),
      from: z.number().int().min(1).max(10).default(3),
      speed: z.number().min(0.5).max(3).default(2), // ticks/sec multiplier
      pos: Point.default({ x: 0.5, y: 0.72 }),
    }),
    curtain: z.object({
      color: z.string().default("#d11069"),
      openDurationSec: z.number().min(0.4).max(4).default(1.4),
      sfx: AssetRef.nullable().default(null),
    }),
  }),

  content: z.object({
    background: AssetRef,
    mic: z.object({ asset: AssetRef, transform: Transform }),
    device: z.object({ asset: AssetRef, transform: Transform }),
    teleprompter: z.object({
      mode: z.enum(["text", "video"]).default("text"),
      screen: ScreenRect,
      text: z
        .object({
          content: z.string(),
          fontSize: z.number().default(64),
          color: z.string().default("#ffffff"),
          bgColor: z.string().default("#000000"),
          align: z.enum(["left", "center"]).default("left"),
          speed: z.number().min(0.3).max(3).default(1),
        })
        .optional(),
      video: z
        .object({ asset: AssetRef, keepAudio: z.boolean().default(true) })
        .optional(),
    }),
    bgm: z
      .object({ asset: AssetRef, volume: z.number().min(0).max(1).default(1) })
      .nullable()
      .default(null),
  }),
});

export type ProjectConfig = z.infer<typeof ProjectConfig>;

const DEFAULT_TELEPROMPTER_TEXT = `Good afternoon passengers. We are now ready to begin boarding Skyline Flight 624 to New York JFK.

At this time, we invite passengers in Group A, as well as those needing special assistance, to make their way to the gate.

Please have your boarding pass and a valid ID ready for scanning. Thank you for flying with us today.`;

export function makeDefaultConfig(): ProjectConfig {
  return {
    version: 1,
    canvas: { ...CANVAS },
    opening: {
      title: {
        text: "Practice Public Speaking (Like a Gate Agent)",
        fontSize: 92,
        color: "#ffffff",
        stroke: true,
        pos: { x: 0.5, y: 0.42 },
      },
      countdown: { enabled: true, from: 3, speed: 2, pos: { x: 0.5, y: 0.72 } },
      curtain: {
        color: "#d11069",
        openDurationSec: 1.4,
        sfx: { kind: "builtin", id: "open-sfx" },
      },
    },
    content: {
      background: { kind: "builtin", id: "airport" },
      mic: {
        asset: { kind: "builtin", id: "mic" },
        transform: { x: 0.78, y: 0.17, scale: 1, rotation: 0, flipH: false, flipV: false },
      },
      device: {
        asset: { kind: "builtin", id: "phone" },
        transform: { x: 0.55, y: 0.58, scale: 1, rotation: 0, flipH: false, flipV: false },
      },
      teleprompter: {
        mode: "text",
        // aligned to the black screen inside the built-in device image (measured)
        screen: { x: 0.114, y: 0.02, w: 0.575, h: 0.86 },
        text: {
          content: DEFAULT_TELEPROMPTER_TEXT,
          fontSize: 60,
          color: "#ffffff",
          bgColor: "#000000",
          align: "left",
          speed: 1,
        },
      },
      bgm: { asset: { kind: "builtin", id: "airport-bgm" }, volume: 1 },
    },
  };
}
