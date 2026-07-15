import {
  DEFAULT_ENDING_ASSET_ID,
  DEFAULT_ENDING_DURATION_SEC,
  type ProjectConfig,
} from "./config-schema";

// The Remotion composition never sees AssetRef ids — only resolved sources.
// `builtin: true` means "draw the built-in placeholder"; `src` is a usable URL
// (blob: in the browser, http(s): in the renderer) or null.

export type ResolvedAsset = {
  builtin: boolean;
  src: string | null;
  builtinId?: string; // built-in asset key (e.g. "airport", "mic") for file mapping
  durationSec?: number;
};

export type ResolvedConfig = {
  canvas: { width: number; height: number; fps: number };
  opening: {
    title: {
      text: string;
      fontSize: number;
      color: string;
      stroke: boolean;
      x: number;
      y: number;
    };
    countdown: { enabled: boolean; from: number; speed: number; fontSize: number; x: number; y: number };
    curtain: { color: string; openDurationSec: number };
    sfx: ResolvedAsset | null;
  };
  content: {
    background: ResolvedAsset;
    mic: { asset: ResolvedAsset } & Transform;
    device: { asset: ResolvedAsset } & Transform;
    teleprompter: {
      mode: "text" | "video";
      screen: { x: number; y: number; w: number; h: number };
      text?: {
        content: string;
        fontSize: number;
        color: string;
        bgColor: string;
        align: "left" | "center";
        speed: number;
      };
      video?: { asset: ResolvedAsset; keepAudio: boolean };
    };
    bgm: { asset: ResolvedAsset; volume: number } | null;
  };
  ending: {
    video: { asset: ResolvedAsset; keepAudio: boolean };
  };
};

type Transform = { x: number; y: number; scale: number; rotation: number; flipH: boolean; flipV: boolean };

type UrlMap = Record<string, string | undefined>;

function resolveAsset(
  ref: { kind: "builtin" | "upload"; id: string; durationSec?: number } | null | undefined,
  urls: UrlMap,
  fallback?: { id: string; durationSec?: number },
): ResolvedAsset {
  if (!ref) {
    return {
      builtin: true,
      src: null,
      builtinId: fallback?.id,
      durationSec: fallback?.durationSec,
    };
  }
  const url = ref.kind === "upload" ? urls[ref.id] : undefined;
  if (ref.kind === "upload" && !url && fallback) {
    return {
      builtin: true,
      src: null,
      builtinId: fallback.id,
      durationSec: fallback.durationSec,
    };
  }
  // Uploads with a missing URL (e.g. after reload, blob gone) fall back to builtin.
  return {
    builtin: ref.kind !== "upload" || !url,
    src: url ?? null,
    builtinId: ref.kind === "builtin" ? ref.id : undefined,
    durationSec: ref.durationSec,
  };
}

export function resolveConfig(cfg: ProjectConfig, urls: UrlMap): ResolvedConfig {
  const t = cfg.content.teleprompter;
  return {
    canvas: cfg.canvas,
    opening: {
      title: {
        text: cfg.opening.title.text,
        fontSize: cfg.opening.title.fontSize,
        color: cfg.opening.title.color,
        stroke: cfg.opening.title.stroke,
        x: cfg.opening.title.pos.x,
        y: cfg.opening.title.pos.y,
      },
      countdown: {
        enabled: cfg.opening.countdown.enabled,
        from: cfg.opening.countdown.from,
        speed: cfg.opening.countdown.speed,
        fontSize: cfg.opening.countdown.fontSize,
        x: cfg.opening.countdown.pos.x,
        y: cfg.opening.countdown.pos.y,
      },
      curtain: {
        color: cfg.opening.curtain.color,
        openDurationSec: cfg.opening.curtain.openDurationSec,
      },
      sfx: cfg.opening.curtain.sfx
        ? resolveAsset(cfg.opening.curtain.sfx, urls)
        : null,
    },
    content: {
      background: resolveAsset(cfg.content.background, urls),
      mic: { asset: resolveAsset(cfg.content.mic.asset, urls), ...cfg.content.mic.transform },
      device: {
        asset: resolveAsset(cfg.content.device.asset, urls),
        ...cfg.content.device.transform,
      },
      teleprompter: {
        mode: t.mode,
        screen: { ...t.screen },
        text: t.text ? { ...t.text } : undefined,
        video: t.video
          ? { asset: resolveAsset(t.video.asset, urls), keepAudio: t.video.keepAudio }
          : undefined,
      },
      bgm: cfg.content.bgm
        ? { asset: resolveAsset(cfg.content.bgm.asset, urls), volume: cfg.content.bgm.volume }
        : null,
    },
    ending: {
      video: {
        asset: resolveAsset(cfg.ending.video.asset, urls, {
          id: DEFAULT_ENDING_ASSET_ID,
          durationSec: DEFAULT_ENDING_DURATION_SEC,
        }),
        keepAudio: cfg.ending.video.keepAudio,
      },
    },
  };
}
