/**
 * Asset capabilities shared by the editor schema, CLI and Remotion runtime.
 *
 * Keep built-in ids, public paths and media types in this file only. Consumers
 * derive their own presentation (CLI metadata, staticFile paths, validation)
 * from this registry instead of maintaining parallel maps.
 */

export type AssetMediaType = "image" | "audio" | "video";

export const ASSET_MEDIA_TYPE_LABELS: Readonly<Record<AssetMediaType, string>> = {
  image: "图片",
  audio: "音频",
  video: "视频",
};

export const ASSET_SLOT_REGISTRY = {
  openingSfx: {
    path: ["opening", "curtain", "sfx"],
    usage: "opening.curtain.sfx",
    label: "开场音效 opening.curtain.sfx",
    mediaType: "audio",
  },
  background: {
    path: ["content", "background"],
    usage: "content.background",
    label: "背景图 content.background",
    mediaType: "image",
  },
  microphone: {
    path: ["content", "mic", "asset"],
    usage: "content.mic.asset",
    label: "麦克风图 content.mic.asset",
    mediaType: "image",
  },
  device: {
    path: ["content", "device", "asset"],
    usage: "content.device.asset",
    label: "设备图 content.device.asset",
    mediaType: "image",
  },
  teleprompterVideo: {
    path: ["content", "teleprompter", "video", "asset"],
    usage: "content.teleprompter.video.asset",
    label: "提词器视频 content.teleprompter.video.asset",
    mediaType: "video",
  },
  backgroundMusic: {
    path: ["content", "bgm", "asset"],
    usage: "content.bgm.asset",
    label: "背景音乐 content.bgm.asset",
    mediaType: "audio",
  },
  endingVideo: {
    path: ["ending", "video", "asset"],
    usage: "ending.video.asset",
    label: "片尾视频 ending.video.asset",
    mediaType: "video",
  },
} as const satisfies Record<
  string,
  {
    path: readonly string[];
    usage: string;
    label: string;
    mediaType: AssetMediaType;
  }
>;

export type AssetSlotId = keyof typeof ASSET_SLOT_REGISTRY;

export type AssetSlotDefinition = (typeof ASSET_SLOT_REGISTRY)[AssetSlotId] & {
  id: AssetSlotId;
};

export const ASSET_SLOTS: readonly AssetSlotDefinition[] = Object.entries(
  ASSET_SLOT_REGISTRY,
).map(([id, slot]) => ({ id: id as AssetSlotId, ...slot }));

type BuiltinAssetDefinitionBase = {
  publicPath: string;
  mime: string;
  defaultSlot: AssetSlotId;
  /** Slots whose renderer behavior is implemented for this exact asset. */
  allowedSlots: readonly AssetSlotId[];
  description: string;
};

/** Every built-in video must declare an authoritative duration. */
export type BuiltinAssetDefinition = BuiltinAssetDefinitionBase &
  (
    | { mediaType: "video"; durationSec: number }
    | { mediaType: "image" | "audio"; durationSec?: number }
  );

export const BUILTIN_ASSET_REGISTRY = {
  airport: {
    publicPath: "assets/builtin/airport.jpg",
    mime: "image/jpeg",
    mediaType: "image",
    defaultSlot: "background",
    allowedSlots: ["background"],
    description: "机场值机口背景图",
  },
  mic: {
    publicPath: "assets/builtin/microphone.png",
    mime: "image/png",
    mediaType: "image",
    defaultSlot: "microphone",
    allowedSlots: ["microphone"],
    description: "手持麦克风",
  },
  phone: {
    publicPath: "assets/builtin/teleprompter.png",
    mime: "image/png",
    mediaType: "image",
    defaultSlot: "device",
    allowedSlots: ["device"],
    description: "手持提词器手机",
  },
  "open-sfx": {
    publicPath: "assets/builtin/open-sfx.mp3",
    mime: "audio/mpeg",
    mediaType: "audio",
    defaultSlot: "openingSfx",
    allowedSlots: ["openingSfx"],
    description: "开场幕布音效",
  },
  "airport-bgm": {
    publicPath: "assets/builtin/airport-bgm.mp3",
    mime: "audio/mpeg",
    mediaType: "audio",
    defaultSlot: "backgroundMusic",
    allowedSlots: ["backgroundMusic"],
    description: "机场广播背景音",
  },
  "flowprompter-outro": {
    publicPath: "assets/builtin/flowprompter-outro.mp4",
    mime: "video/mp4",
    mediaType: "video",
    defaultSlot: "endingVideo",
    // The teleprompter renderer only implements uploaded video sources. Keep
    // this outro confined to the Ending scene until that path is implemented.
    allowedSlots: ["endingVideo"],
    description: "FlowPrompter 默认片尾",
    durationSec: 2.227664,
  },
} as const satisfies Record<string, BuiltinAssetDefinition>;

export type BuiltinAssetId = keyof typeof BUILTIN_ASSET_REGISTRY;

export type BuiltinAsset = BuiltinAssetDefinition & {
  id: BuiltinAssetId;
};

export const BUILTIN_ASSETS: readonly BuiltinAsset[] = Object.entries(
  BUILTIN_ASSET_REGISTRY,
).map(([id, asset]) => ({ id: id as BuiltinAssetId, ...asset }));

export function getBuiltinAsset(id: string): BuiltinAsset | undefined {
  if (!Object.hasOwn(BUILTIN_ASSET_REGISTRY, id)) return undefined;
  const typedId = id as BuiltinAssetId;
  return { id: typedId, ...BUILTIN_ASSET_REGISTRY[typedId] };
}

export function mediaTypeForMime(mime: string): AssetMediaType | undefined {
  const type = mime.trim().toLowerCase().split("/", 1)[0];
  return type === "image" || type === "audio" || type === "video" ? type : undefined;
}

/** Stable shape consumed by `assets`/capability commands. */
export function listBuiltinAssetMetadata(): Array<{
  id: BuiltinAssetId;
  type: AssetMediaType;
  mime: string;
  usage: string;
  allowedSlots: AssetSlotId[];
  usages: string[];
  desc: string;
  durationSec?: number;
}> {
  return BUILTIN_ASSETS.map((asset) => ({
    id: asset.id,
    type: asset.mediaType,
    mime: asset.mime,
    usage: ASSET_SLOT_REGISTRY[asset.defaultSlot].usage,
    allowedSlots: [...asset.allowedSlots],
    usages: asset.allowedSlots.map((slot) => ASSET_SLOT_REGISTRY[slot].usage),
    desc: asset.description,
    ...(asset.durationSec === undefined ? {} : { durationSec: asset.durationSec }),
  }));
}
