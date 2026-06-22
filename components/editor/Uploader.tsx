"use client";

import { useRef } from "react";
import { Upload, Check } from "lucide-react";
import { useEditor, type AssetTarget } from "@/lib/store";

export function Uploader({
  target,
  accept,
  icon,
  defaultName,
  hint,
}: {
  target: AssetTarget;
  accept: string;
  icon: React.ReactNode;
  defaultName: string;
  hint?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const addAsset = useEditor((s) => s.addAsset);
  const fileNames = useEditor((s) => s.fileNames);
  const config = useEditor((s) => s.config);

  // Resolve the asset id currently bound to this target to show its filename.
  const id = assetIdFor(target, config);
  const uploadedName = id ? fileNames[id] : undefined;

  return (
    <button
      type="button"
      onClick={() => inputRef.current?.click()}
      className="flex w-full items-center gap-3 rounded-xl border border-dashed border-border bg-black/20 p-3 text-left transition-colors hover:border-[#ff2d7e]"
    >
      <span className="grid size-10 flex-none place-items-center rounded-lg bg-muted text-lg">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium">
          {uploadedName ?? defaultName}
        </span>
        <span className="mt-0.5 flex items-center gap-1 text-[11px] text-emerald-400">
          {uploadedName ? <Check className="size-3" /> : null}
          {uploadedName ? "已上传 · 点击替换" : hint ?? "点击上传"}
        </span>
      </span>
      <Upload className="size-4 flex-none text-muted-foreground" />
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void addAsset(target, f);
          e.target.value = "";
        }}
      />
    </button>
  );
}

function assetIdFor(target: AssetTarget, config: ReturnType<typeof useEditor.getState>["config"]) {
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
      return config.opening.curtain.sfx?.kind === "upload" ? config.opening.curtain.sfx.id : null;
  }
}
