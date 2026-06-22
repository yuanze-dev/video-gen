"use client";

import { create } from "zustand";
import { ProjectConfig, makeDefaultConfig, type AssetRef } from "./config-schema";
import { getMediaDuration } from "./media";

export type ContentTarget = "mic" | "device";
export type OpeningTarget = "title" | "countdown";
export type DragTarget = ContentTarget | OpeningTarget;
export type AssetTarget = "background" | "mic" | "device" | "teleVideo" | "bgm" | "sfx";
export type SceneView = "opening" | "content";

type Patch = Partial<{
  x: number;
  y: number;
  scale: number;
  rotation: number;
  flipH: boolean;
  flipV: boolean;
}>;

type State = {
  config: ProjectConfig;
  assetUrls: Record<string, string>; // asset id -> object URL (preview only)
  fileNames: Record<string, string>; // asset id -> original filename
  view: SceneView;
  selected: DragTarget | null;

  setView: (v: SceneView) => void;
  setSelected: (s: DragTarget | null) => void;

  setTitleText: (t: string) => void;
  toggleCountdown: (enabled: boolean) => void;
  setCountdownSpeed: (speed: number) => void;
  setCurtainColor: (color: string) => void;
  setTeleMode: (mode: "text" | "video") => void;
  setTeleText: (content: string) => void;
  setTeleSpeed: (speed: number) => void;
  setKeepAudio: (keep: boolean) => void;
  setBgmVolume: (v: number) => void;

  setTransform: (target: ContentTarget, patch: Patch) => void;
  setOpeningPos: (target: OpeningTarget, patch: Partial<{ x: number; y: number }>) => void;
  setScreen: (patch: Partial<{ x: number; y: number; w: number; h: number }>) => void;
  addAsset: (target: AssetTarget, file: File) => Promise<void>;

  loadConfig: (cfg: ProjectConfig) => void;
  resetConfig: () => void;
  exportJson: () => string;
  importJson: (s: string) => { ok: boolean; error?: string };
};

let assetSeq = 0;
const newAssetId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `a${Date.now()}_${assetSeq++}`;

export const useEditor = create<State>((set, get) => ({
  config: makeDefaultConfig(),
  assetUrls: {},
  fileNames: {},
  view: "opening",
  selected: null,

  setView: (view) => set({ view }),
  setSelected: (selected) => set({ selected }),

  setTitleText: (text) =>
    set((s) => ({
      config: {
        ...s.config,
        opening: {
          ...s.config.opening,
          title: { ...s.config.opening.title, text },
        },
      },
    })),

  toggleCountdown: (enabled) =>
    set((s) => ({
      config: {
        ...s.config,
        opening: {
          ...s.config.opening,
          countdown: { ...s.config.opening.countdown, enabled },
        },
      },
    })),

  setCountdownSpeed: (speed) =>
    set((s) => ({
      config: {
        ...s.config,
        opening: {
          ...s.config.opening,
          countdown: { ...s.config.opening.countdown, speed },
        },
      },
    })),

  setCurtainColor: (color) =>
    set((s) => ({
      config: {
        ...s.config,
        opening: {
          ...s.config.opening,
          curtain: { ...s.config.opening.curtain, color },
        },
      },
    })),

  setTeleMode: (mode) =>
    set((s) => ({
      config: {
        ...s.config,
        content: {
          ...s.config.content,
          teleprompter: { ...s.config.content.teleprompter, mode },
        },
      },
    })),

  setTeleText: (content) =>
    set((s) => {
      const t = s.config.content.teleprompter;
      const text = { ...(t.text ?? defaultText()), content };
      return {
        config: {
          ...s.config,
          content: {
            ...s.config.content,
            teleprompter: { ...t, text },
          },
        },
      };
    }),

  setTeleSpeed: (speed) =>
    set((s) => {
      const t = s.config.content.teleprompter;
      const text = { ...(t.text ?? defaultText()), speed };
      return {
        config: {
          ...s.config,
          content: { ...s.config.content, teleprompter: { ...t, text } },
        },
      };
    }),

  setKeepAudio: (keepAudio) =>
    set((s) => {
      const t = s.config.content.teleprompter;
      if (!t.video) return {};
      return {
        config: {
          ...s.config,
          content: {
            ...s.config.content,
            teleprompter: { ...t, video: { ...t.video, keepAudio } },
          },
        },
      };
    }),

  setBgmVolume: (volume) =>
    set((s) => {
      if (!s.config.content.bgm) return {};
      return {
        config: {
          ...s.config,
          content: {
            ...s.config.content,
            bgm: { ...s.config.content.bgm, volume },
          },
        },
      };
    }),

  setTransform: (target, patch) =>
    set((s) => {
      const node = s.config.content[target];
      return {
        config: {
          ...s.config,
          content: {
            ...s.config.content,
            [target]: { ...node, transform: { ...node.transform, ...patch } },
          },
        },
      };
    }),

  setOpeningPos: (target, patch) =>
    set((s) => {
      const node = s.config.opening[target];
      return {
        config: {
          ...s.config,
          opening: {
            ...s.config.opening,
            [target]: { ...node, pos: { ...node.pos, ...patch } },
          },
        },
      };
    }),

  setScreen: (patch) =>
    set((s) => ({
      config: {
        ...s.config,
        content: {
          ...s.config.content,
          teleprompter: {
            ...s.config.content.teleprompter,
            screen: { ...s.config.content.teleprompter.screen, ...patch },
          },
        },
      },
    })),

  addAsset: async (target, file) => {
    const id = newAssetId();
    const url = URL.createObjectURL(file);
    const isVideo = file.type.startsWith("video");
    const isAudio = file.type.startsWith("audio");
    let durationSec: number | undefined;
    if (isVideo) durationSec = await getMediaDuration(file, "video");
    else if (isAudio) durationSec = await getMediaDuration(file, "audio");

    const ref: AssetRef = { kind: "upload", id, mime: file.type, durationSec };

    set((s) => {
      const assetUrls = { ...s.assetUrls, [id]: url };
      const fileNames = { ...s.fileNames, [id]: file.name };
      const content = { ...s.config.content };
      const opening = { ...s.config.opening };

      switch (target) {
        case "background":
          content.background = ref;
          break;
        case "mic":
          content.mic = { ...content.mic, asset: ref };
          break;
        case "device":
          content.device = { ...content.device, asset: ref };
          break;
        case "teleVideo":
          content.teleprompter = {
            ...content.teleprompter,
            mode: "video",
            video: { asset: ref, keepAudio: content.teleprompter.video?.keepAudio ?? true },
          };
          break;
        case "bgm":
          content.bgm = { asset: ref, volume: content.bgm?.volume ?? 1 };
          break;
        case "sfx":
          opening.curtain = { ...opening.curtain, sfx: ref };
          break;
      }
      return { assetUrls, fileNames, config: { ...s.config, content, opening } };
    });
  },

  loadConfig: (cfg) => set({ config: cfg, assetUrls: {}, fileNames: {}, selected: null }),
  resetConfig: () => set({ config: makeDefaultConfig(), assetUrls: {}, fileNames: {}, selected: null }),

  exportJson: () => JSON.stringify(get().config, null, 2),
  importJson: (s) => {
    try {
      const parsed = ProjectConfig.safeParse(JSON.parse(s));
      if (!parsed.success) return { ok: false, error: "配置格式不符" };
      set({ config: parsed.data, assetUrls: {}, fileNames: {}, selected: null });
      return { ok: true };
    } catch {
      return { ok: false, error: "JSON 解析失败" };
    }
  },
}));

function defaultText() {
  return makeDefaultConfig().content.teleprompter.text!;
}
