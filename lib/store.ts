"use client";

import { create } from "zustand";
import { ProjectConfig, makeDefaultConfig, type AssetRef } from "./config-schema";
import { getMediaDuration } from "./media";

export type ContentTarget = "mic" | "device";
export type OpeningTarget = "title" | "countdown";
export type DragTarget = ContentTarget | OpeningTarget;
export type AssetTarget =
  | "background"
  | "mic"
  | "device"
  | "teleVideo"
  | "bgm"
  | "sfx"
  | "endingVideo";
export type SceneView = "opening" | "content" | "ending";

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
  viewFocusRevision: number;
  selected: DragTarget | null;

  setView: (v: SceneView) => void;
  focusView: (v: SceneView) => void;
  setSelected: (s: DragTarget | null) => void;

  setTitleText: (t: string) => void;
  setTitleFontSize: (size: number) => void;
  toggleCountdown: (enabled: boolean) => void;
  setCountdownSpeed: (speed: number) => void;
  setCountdownFontSize: (size: number) => void;
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
  resetAsset: (target: AssetTarget) => void;

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

const ASSET_TARGETS: AssetTarget[] = [
  "background",
  "mic",
  "device",
  "teleVideo",
  "bgm",
  "sfx",
  "endingVideo",
];

const assetJobVersion: Record<AssetTarget, number> = {
  background: 0,
  mic: 0,
  device: 0,
  teleVideo: 0,
  bgm: 0,
  sfx: 0,
  endingVideo: 0,
};

const nextAssetJob = (target: AssetTarget) => ++assetJobVersion[target];

const invalidateAssetJobs = () => {
  for (const target of ASSET_TARGETS) assetJobVersion[target] += 1;
};

const revokeUrl = (url: string | undefined) => {
  if (url && typeof URL !== "undefined") URL.revokeObjectURL(url);
};

const revokeUrls = (urls: Record<string, string>) => {
  for (const url of Object.values(urls)) revokeUrl(url);
};

export const useEditor = create<State>((set, get) => ({
  config: makeDefaultConfig(),
  assetUrls: {},
  fileNames: {},
  view: "opening",
  viewFocusRevision: 0,
  selected: null,

  setView: (view) => set({ view }),
  focusView: (view) =>
    set((s) => ({ view, viewFocusRevision: s.viewFocusRevision + 1 })),
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

  setTitleFontSize: (fontSize) =>
    set((s) => ({
      config: {
        ...s.config,
        opening: {
          ...s.config.opening,
          title: { ...s.config.opening.title, fontSize },
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

  setCountdownFontSize: (fontSize) =>
    set((s) => ({
      config: {
        ...s.config,
        opening: {
          ...s.config.opening,
          countdown: { ...s.config.opening.countdown, fontSize },
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

  setTeleMode: (mode) => {
    if (mode === "text") nextAssetJob("teleVideo");
    set((s) => ({
      config: {
        ...s.config,
        content: {
          ...s.config.content,
          teleprompter: { ...s.config.content.teleprompter, mode },
        },
      },
    }));
  },

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
    set((s) => {
      const profile = s.config.content.device.profile;
      return {
        config: {
          ...s.config,
          content: {
            ...s.config.content,
            device: profile
              ? {
                  ...s.config.content.device,
                  profile: {
                    ...profile,
                    screen: { ...profile.screen, ...patch },
                  },
                }
              : s.config.content.device,
            teleprompter: {
              ...s.config.content.teleprompter,
              // Keep the legacy fallback synchronized so removing a profile
              // never moves the screen unexpectedly.
              screen: { ...s.config.content.teleprompter.screen, ...patch },
            },
          },
        },
      };
    }),

  addAsset: async (target, file) => {
    const job = nextAssetJob(target);
    const id = newAssetId();
    const url = URL.createObjectURL(file);
    // File.type can be empty on some browsers/platforms. The destination is a
    // stronger signal for slots that require media duration.
    const isVideo =
      target === "teleVideo" || target === "endingVideo" || file.type.startsWith("video");
    const isAudio = target === "bgm" || target === "sfx" || file.type.startsWith("audio");
    let durationSec: number | undefined;
    try {
      if (isVideo) durationSec = await getMediaDuration(file, "video");
      else if (isAudio) durationSec = await getMediaDuration(file, "audio");
    } catch (error) {
      revokeUrl(url);
      throw error;
    }

    // A reset or a newer upload may finish while media metadata is loading.
    // In that case the stale job must not overwrite the user's latest choice.
    if (assetJobVersion[target] !== job) {
      revokeUrl(url);
      return;
    }

    const ref: AssetRef = { kind: "upload", id, mime: file.type, durationSec };

    const current = get();
    const previousId = uploadedAssetIdFor(target, current.config);
    const content = { ...current.config.content };
    const opening = { ...current.config.opening };
    const ending = { ...current.config.ending };

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
      case "endingVideo":
        ending.video = { ...ending.video, asset: ref };
        break;
    }

    const config = { ...current.config, content, opening, ending };
    const cleanup = removeUnusedUpload(
      previousId,
      config,
      { ...current.assetUrls, [id]: url },
      { ...current.fileNames, [id]: file.name },
    );
    set({ config, assetUrls: cleanup.assetUrls, fileNames: cleanup.fileNames });
    revokeUrl(cleanup.urlToRevoke);
  },

  resetAsset: (target) => {
    nextAssetJob(target);

    const current = get();
    const previousId = uploadedAssetIdFor(target, current.config);
    const config = resetAssetInConfig(current.config, target);
    const cleanup = removeUnusedUpload(
      previousId,
      config,
      current.assetUrls,
      current.fileNames,
    );
    set({ config, assetUrls: cleanup.assetUrls, fileNames: cleanup.fileNames });
    revokeUrl(cleanup.urlToRevoke);
  },

  loadConfig: (cfg) => {
    invalidateAssetJobs();
    revokeUrls(get().assetUrls);
    set({
      config: normalizeConfigWithoutUploads(cfg),
      assetUrls: {},
      fileNames: {},
      selected: null,
    });
  },
  resetConfig: () => {
    invalidateAssetJobs();
    revokeUrls(get().assetUrls);
    set({ config: makeDefaultConfig(), assetUrls: {}, fileNames: {}, selected: null });
  },

  exportJson: () => JSON.stringify(get().config, null, 2),
  importJson: (s) => {
    try {
      const parsed = ProjectConfig.safeParse(JSON.parse(s));
      if (!parsed.success) return { ok: false, error: "配置格式不符" };
      invalidateAssetJobs();
      revokeUrls(get().assetUrls);
      set({
        config: normalizeConfigWithoutUploads(parsed.data),
        assetUrls: {},
        fileNames: {},
        selected: null,
      });
      return { ok: true };
    } catch {
      return { ok: false, error: "JSON 解析失败" };
    }
  },
}));

function defaultText() {
  return makeDefaultConfig().content.teleprompter.text!;
}

function normalizeConfigWithoutUploads(config: ProjectConfig) {
  const defaults = makeDefaultConfig();
  return ASSET_TARGETS.reduce(
    (next, target) =>
      uploadedAssetIdFor(target, next) ? resetAssetInConfig(next, target, defaults) : next,
    config,
  );
}

function resetAssetInConfig(
  config: ProjectConfig,
  target: AssetTarget,
  defaults = makeDefaultConfig(),
) {
  const content = { ...config.content };
  const opening = { ...config.opening };
  const ending = { ...config.ending };

  switch (target) {
    case "background":
      content.background = defaults.content.background;
      break;
    case "mic":
      content.mic = { ...content.mic, asset: defaults.content.mic.asset };
      break;
    case "device":
      content.device = { ...content.device, asset: defaults.content.device.asset };
      content.teleprompter = {
        ...content.teleprompter,
        screen: defaults.content.teleprompter.screen,
      };
      break;
    case "teleVideo":
      content.teleprompter = {
        ...content.teleprompter,
        mode: "text",
        text: content.teleprompter.text ?? defaults.content.teleprompter.text,
        video: undefined,
      };
      break;
    case "bgm":
      content.bgm = {
        asset: defaults.content.bgm!.asset,
        volume: content.bgm?.volume ?? defaults.content.bgm!.volume,
      };
      break;
    case "sfx":
      opening.curtain = {
        ...opening.curtain,
        sfx: defaults.opening.curtain.sfx,
      };
      break;
    case "endingVideo":
      ending.video = defaults.ending.video;
      break;
  }

  return { ...config, content, opening, ending };
}

function uploadedAssetIdFor(target: AssetTarget, config: ProjectConfig) {
  switch (target) {
    case "background":
      return config.content.background.kind === "upload" ? config.content.background.id : null;
    case "mic":
      return config.content.mic.asset.kind === "upload" ? config.content.mic.asset.id : null;
    case "device":
      return config.content.device.asset.kind === "upload" ? config.content.device.asset.id : null;
    case "teleVideo":
      return config.content.teleprompter.video?.asset.kind === "upload"
        ? config.content.teleprompter.video.asset.id
        : null;
    case "bgm":
      return config.content.bgm?.asset.kind === "upload" ? config.content.bgm.asset.id : null;
    case "sfx":
      return config.opening.curtain.sfx?.kind === "upload"
        ? config.opening.curtain.sfx.id
        : null;
    case "endingVideo":
      return config.ending.video.asset.kind === "upload" ? config.ending.video.asset.id : null;
  }
}

function isUploadReferenced(config: ProjectConfig, id: string) {
  const refs: Array<AssetRef | null | undefined> = [
    config.content.background,
    config.content.mic.asset,
    config.content.device.asset,
    config.content.teleprompter.video?.asset,
    config.content.bgm?.asset,
    config.opening.curtain.sfx,
    config.ending.video.asset,
  ];
  return refs.some((ref) => ref?.kind === "upload" && ref.id === id);
}

function removeUnusedUpload(
  id: string | null,
  config: ProjectConfig,
  assetUrls: Record<string, string>,
  fileNames: Record<string, string>,
) {
  if (!id || isUploadReferenced(config, id)) {
    return { assetUrls, fileNames, urlToRevoke: undefined };
  }

  const nextAssetUrls = { ...assetUrls };
  const nextFileNames = { ...fileNames };
  const urlToRevoke = nextAssetUrls[id];
  delete nextAssetUrls[id];
  delete nextFileNames[id];
  return { assetUrls: nextAssetUrls, fileNames: nextFileNames, urlToRevoke };
}
