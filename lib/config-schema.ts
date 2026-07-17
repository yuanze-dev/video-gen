import { z } from "zod";
import {
  ASSET_MEDIA_TYPE_LABELS,
  ASSET_SLOT_REGISTRY,
  ASSET_SLOTS,
  BUILTIN_ASSET_REGISTRY,
  getBuiltinAsset,
  mediaTypeForMime,
  type BuiltinAssetId,
} from "./asset-registry";
import { CANVAS } from "./constants";

// All spatial values are normalized 0..1 relative to the canvas, so the small
// editor preview and the 1080x1920 render are equivalent.

// The editor uses <input type="color">, whose interoperable value form is
// exactly #RRGGBB. Keeping the schema aligned avoids a config that renders but
// cannot be represented when reopened in the GUI.
const HEX_COLOR_RE = /^#[\da-f]{6}$/i;
const ASSET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const MIME_RE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/;

export const MAX_ASSET_DURATION_SEC = 6 * 60 * 60;

const normalizedPosition = (label: string) =>
  z
    .number()
    .min(0, { message: `${label}不能小于 0` })
    .max(1, { message: `${label}不能大于 1` });

const color = (label: string) =>
  z.string().regex(HEX_COLOR_RE, {
    message: `${label}必须是 6 位十六进制颜色，例如 #ffffff`,
  });

const fontSize = (min: number, max: number, label: string) =>
  z
    .number()
    .min(min, { message: `${label}不能小于 ${min}px` })
    .max(max, { message: `${label}不能大于 ${max}px` });

export const Point = z
  .object({
    x: normalizedPosition("x 坐标"),
    y: normalizedPosition("y 坐标"),
  })
  .strict();

export const Transform = z
  .object({
    // Draggable elements may move 10% beyond the canvas in the editor.
    x: z
      .number()
      .min(-0.1, { message: "x 坐标不能小于 -0.1" })
      .max(1.1, { message: "x 坐标不能大于 1.1" }),
    y: z
      .number()
      .min(-0.1, { message: "y 坐标不能小于 -0.1" })
      .max(1.1, { message: "y 坐标不能大于 1.1" }),
    scale: z
      .number()
      .min(0.4, { message: "缩放比不能小于 0.4" })
      .max(2.5, { message: "缩放比不能大于 2.5" })
      .default(1),
    rotation: z
      .number()
      .min(-360, { message: "旋转角度不能小于 -360°" })
      .max(360, { message: "旋转角度不能大于 360°" })
      .default(0),
    flipH: z.boolean().default(false),
    flipV: z.boolean().default(false),
  })
  .strict();

// Inset rectangle (fractions 0..1) of the device box that acts as the
// teleprompter "screen". Content (text or video) is clipped to this region.
export const ScreenRect = z
  .object({
    x: normalizedPosition("屏幕 x 坐标"),
    y: normalizedPosition("屏幕 y 坐标"),
    w: z
      .number()
      .min(0.1, { message: "屏幕宽度不能小于 0.1" })
      .max(1, { message: "屏幕宽度不能大于 1" }),
    h: z
      .number()
      .min(0.1, { message: "屏幕高度不能小于 0.1" })
      .max(1, { message: "屏幕高度不能大于 1" }),
  })
  .strict()
  .superRefine((rect, ctx) => {
    if (rect.x + rect.w > 1 + Number.EPSILON) {
      ctx.addIssue({
        code: "custom",
        path: ["w"],
        message: "屏幕右边界超出设备范围（x + w 必须小于等于 1）",
      });
    }
    if (rect.y + rect.h > 1 + Number.EPSILON) {
      ctx.addIssue({
        code: "custom",
        path: ["h"],
        message: "屏幕下边界超出设备范围（y + h 必须小于等于 1）",
      });
    }
  });

const AssetRefBase = z
  .object({
    kind: z.enum(["builtin", "upload"]),
    id: z
      .string()
      .min(1, { message: "素材 id 不能为空" })
      .max(128, { message: "素材 id 不能超过 128 个字符" })
      .regex(ASSET_ID_RE, {
        message: "素材 id 只能包含英文字母、数字、点、下划线、冒号和连字符",
      }),
    mime: z
      .string()
      .max(127, { message: "MIME 类型不能超过 127 个字符" })
      .regex(MIME_RE, { message: "MIME 类型格式不正确，例如 video/mp4" })
      .optional(),
    durationSec: z
      .number()
      .positive({ message: "素材时长 durationSec 必须大于 0" })
      .max(MAX_ASSET_DURATION_SEC, {
        message: `素材时长 durationSec 不能超过 ${MAX_ASSET_DURATION_SEC} 秒`,
      })
      .optional(),
  })
  .strict();

export const AssetRef = AssetRefBase.superRefine((ref, ctx) => {
  if (ref.kind !== "builtin") return;
  const builtin = getBuiltinAsset(ref.id);
  if (
    builtin?.mediaType === "video" &&
    ref.durationSec !== undefined &&
    ref.durationSec !== builtin.durationSec
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["durationSec"],
      message: `内置视频 "${ref.id}" 的 durationSec 由素材 registry 固定为 ${builtin.durationSec}，不能覆盖为 ${ref.durationSec}`,
    });
  }
}).overwrite((ref) => {
  if (ref.kind !== "builtin") return ref;
  const builtin = getBuiltinAsset(ref.id);
  if (builtin?.mediaType !== "video" || ref.durationSec !== undefined) return ref;
  return { ...ref, durationSec: builtin.durationSec };
});
export type AssetRef = z.infer<typeof AssetRef>;

export const DEFAULT_ENDING_ASSET_ID = "flowprompter-outro" as const satisfies BuiltinAssetId;
export const DEFAULT_ENDING_DURATION_SEC =
  BUILTIN_ASSET_REGISTRY[DEFAULT_ENDING_ASSET_ID].durationSec;

const defaultEnding = () => ({
  video: {
    asset: {
      kind: "builtin" as const,
      id: DEFAULT_ENDING_ASSET_ID,
      mime: "video/mp4",
      durationSec: DEFAULT_ENDING_DURATION_SEC,
    },
    keepAudio: true,
  },
});

const ProjectConfigBase = z
  .object({
    version: z.literal(1),
    canvas: z
      .object({
        width: z.literal(1080),
        height: z.literal(1920),
        fps: z.literal(60),
      })
      .strict(),

    opening: z
      .object({
        title: z
          .object({
            text: z.string().max(160, { message: "开场标题不能超过 160 个字符" }),
            fontSize: fontSize(40, 200, "开场标题字号").default(96),
            color: color("开场标题颜色").default("#ffffff"),
            stroke: z.boolean().default(true),
            pos: Point,
          })
          .strict(),
        countdown: z
          .object({
            enabled: z.boolean().default(true),
            from: z
              .number()
              .int({ message: "倒计时起始数必须是整数" })
              .min(1, { message: "倒计时起始数不能小于 1" })
              .max(10, { message: "倒计时起始数不能大于 10" })
              .default(3),
            speed: z
              .number()
              .min(0.5, { message: "倒计时速度不能小于 0.5" })
              .max(3, { message: "倒计时速度不能大于 3" })
              .default(2),
            fontSize: fontSize(80, 320, "倒计时字号").default(170),
            pos: Point.default({ x: 0.5, y: 0.72 }),
          })
          .strict(),
        curtain: z
          .object({
            color: color("幕布颜色").default("#d11069"),
            openDurationSec: z
              .number()
              .min(0.4, { message: "幕布打开时长不能小于 0.4 秒" })
              .max(4, { message: "幕布打开时长不能大于 4 秒" })
              .default(1.4),
            sfx: AssetRef.nullable().default(null),
          })
          .strict(),
      })
      .strict(),

    content: z
      .object({
        background: AssetRef,
        mic: z.object({ asset: AssetRef, transform: Transform }).strict(),
        device: z.object({ asset: AssetRef, transform: Transform }).strict(),
        teleprompter: z
          .object({
            mode: z.enum(["text", "video"]).default("text"),
            screen: ScreenRect,
            text: z
              .object({
                content: z.string().max(200_000, { message: "提词内容不能超过 200000 个字符" }),
                fontSize: fontSize(16, 240, "提词文字字号").default(64),
                color: color("提词文字颜色").default("#ffffff"),
                bgColor: color("提词背景颜色").default("#000000"),
                align: z.enum(["left", "center"]).default("left"),
                speed: z
                  .number()
                  .min(0.3, { message: "提词滚动速度不能小于 0.3" })
                  .max(3, { message: "提词滚动速度不能大于 3" })
                  .default(1),
              })
              .strict()
              .optional(),
            video: z
              .object({ asset: AssetRef, keepAudio: z.boolean().default(true) })
              .strict()
              .optional(),
          })
          .strict(),
        bgm: z
          .object({
            asset: AssetRef,
            volume: z
              .number()
              .min(0, { message: "背景音乐音量不能小于 0" })
              .max(1, { message: "背景音乐音量不能大于 1" })
              .default(1),
          })
          .strict()
          .nullable()
          .default(null),
      })
      .strict(),

    // The fixed ending is additive and defaults as a whole so version-1
    // configs saved before it shipped automatically gain the built-in outro.
    ending: z
      .object({
        video: z
          .object({
            asset: AssetRef,
            keepAudio: z.boolean().default(true),
          })
          .strict(),
      })
      .strict()
      .default(defaultEnding()),
  })
  .strict();

function getAtPath(obj: unknown, keys: readonly string[]): unknown {
  let current = obj;
  for (const key of keys) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export const ProjectConfig = ProjectConfigBase.superRefine((config, ctx) => {
  const teleprompter = config.content.teleprompter;
  if (teleprompter.mode === "video" && !teleprompter.video) {
    ctx.addIssue({
      code: "custom",
      path: ["content", "teleprompter", "video"],
      message: 'mode 为 "video" 时必须提供提词器视频',
    });
  }
  if (teleprompter.mode === "text" && !teleprompter.text) {
    ctx.addIssue({
      code: "custom",
      path: ["content", "teleprompter", "text"],
      message: 'mode 为 "text" 时必须提供提词文字',
    });
  }

  for (const slot of ASSET_SLOTS) {
    const value = getAtPath(config, slot.path);
    if (!value || typeof value !== "object" || !("kind" in value)) continue;
    const ref = value as AssetRef;

    if (ref.kind === "builtin") {
      const builtin = getBuiltinAsset(ref.id);
      if (!builtin) {
        ctx.addIssue({
          code: "custom",
          path: [...slot.path, "id"],
          message: `内置素材 "${ref.id}" 不存在`,
        });
      } else if (builtin.mediaType !== slot.mediaType) {
        ctx.addIssue({
          code: "custom",
          path: [...slot.path, "id"],
          message: `${slot.label} 需要${ASSET_MEDIA_TYPE_LABELS[slot.mediaType]}素材，但内置素材 "${ref.id}" 是${ASSET_MEDIA_TYPE_LABELS[builtin.mediaType]}`,
        });
      } else if (!(builtin.allowedSlots as readonly string[]).includes(slot.id)) {
        ctx.addIssue({
          code: "custom",
          path: [...slot.path, "id"],
          message: `内置素材 "${ref.id}" 不支持用于 ${slot.label}；可用位置：${builtin.allowedSlots
            .map((allowed) => ASSET_SLOT_REGISTRY[allowed].usage)
            .join(", ")}`,
        });
      }
    }

    if (ref.kind === "upload" && ref.mime) {
      const mediaType = mediaTypeForMime(ref.mime);
      if (mediaType && mediaType !== slot.mediaType) {
        ctx.addIssue({
          code: "custom",
          path: [...slot.path, "mime"],
          message: `${slot.label} 需要${ASSET_MEDIA_TYPE_LABELS[slot.mediaType]}素材，但 MIME 类型 ${ref.mime} 是${ASSET_MEDIA_TYPE_LABELS[mediaType]}`,
        });
      }
    }
  }
});

export type ProjectConfig = z.infer<typeof ProjectConfig>;

const DEFAULT_TELEPROMPTER_TEXT =
  "\n\n\n\nGood afternoon, ladies and gentlemen. This is the pre-boarding announcement for American Airlines Flight 1287 with service to Dallas/Fort Worth.\nWe are now inviting those passengers with small children, and any passengers requiring special assistance, to begin boarding at this time. Please have your boarding pass and a valid form of identification ready.\nWe would also like to welcome our AAdvantage® Executive Platinum and ConciergeKey® members to board at this time.";

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
        pos: { x: 0.5048, y: 0.2377 },
      },
      countdown: { enabled: true, from: 3, speed: 2, fontSize: 170, pos: { x: 0.4993, y: 0.3864 } },
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
        transform: { x: 0.8982, y: 0.0884, scale: 1.4316, rotation: 0, flipH: false, flipV: true },
      },
      device: {
        asset: { kind: "builtin", id: "phone" },
        transform: { x: 0.5814, y: 0.6989, scale: 1.0407, rotation: 0, flipH: false, flipV: false },
      },
      teleprompter: {
        mode: "text",
        // aligned to the black screen inside the built-in device image
        screen: { x: 0.1258, y: 0.03, w: 0.5534, h: 0.8516 },
        text: {
          content: DEFAULT_TELEPROMPTER_TEXT,
          fontSize: 60,
          color: "#ffffff",
          bgColor: "#000000",
          align: "left",
          speed: 0.7,
        },
      },
      bgm: { asset: { kind: "builtin", id: "airport-bgm" }, volume: 1 },
    },
    ending: defaultEnding(),
  };
}
