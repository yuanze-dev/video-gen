"use client";

import { useRef } from "react";
import { Check, RotateCcw, Upload } from "lucide-react";
import { toast } from "sonner";
import { useEditor, type AssetTarget } from "@/lib/store";

export function Uploader({
  target,
  accept,
  icon,
  defaultName,
  hint,
  builtin = false,
  resetLabel,
  onChoose,
}: {
  target: AssetTarget;
  accept: string;
  icon: React.ReactNode;
  defaultName: string;
  hint?: string;
  builtin?: boolean;
  resetLabel?: string;
  onChoose?: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const addAsset = useEditor((s) => s.addAsset);
  const resetAsset = useEditor((s) => s.resetAsset);
  const fileNames = useEditor((s) => s.fileNames);
  const config = useEditor((s) => s.config);

  // Resolve the asset id currently bound to this target to show its filename.
  const id = assetIdFor(target, config);
  const hasUpload = id !== null;
  const usingBuiltin = builtin && isBuiltinAssetFor(target, config);
  const uploadedName = id ? fileNames[id] ?? "自定义素材" : undefined;
  const availableResetLabel = resetLabel ?? (builtin ? "恢复内置" : undefined);
  const showReset = Boolean(
    availableResetLabel && (hasUpload || (builtin && !usingBuiltin)),
  );

  return (
    <div
      className={`group flex w-full items-stretch overflow-hidden rounded-xl border border-dashed bg-black/20 transition-colors focus-within:border-[#ff2d7e]/70 hover:border-[#ff2d7e]/70 ${
        hasUpload ? "border-[#ff2d7e]/35" : "border-border"
      }`}
    >
      <button
        type="button"
        onClick={() => {
          onChoose?.();
          inputRef.current?.click();
        }}
        className="flex min-w-0 flex-1 items-center gap-3 p-3 text-left outline-none transition-colors hover:bg-white/[0.025] focus-visible:bg-white/[0.04]"
      >
        <span className="grid size-10 flex-none place-items-center rounded-lg bg-muted text-lg transition-colors group-hover:bg-muted/80">
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[13px] font-medium">
              {uploadedName ?? defaultName}
            </span>
            {usingBuiltin ? (
              <span className="flex-none rounded-full bg-emerald-400/10 px-1.5 py-0.5 text-[9px] font-medium text-emerald-400">
                内置
              </span>
            ) : null}
          </span>
          <span
            className={`mt-0.5 flex items-center gap-1 text-[11px] ${
              hasUpload ? "text-[#ff6da5]" : "text-muted-foreground"
            }`}
          >
            {hasUpload ? <Check className="size-3" /> : null}
            {hasUpload ? "自定义素材 · 点击替换" : hint ?? "点击上传"}
          </span>
        </span>
        <Upload className="size-4 flex-none text-muted-foreground transition-colors group-hover:text-[#ff6da5]" />
      </button>

      {showReset && availableResetLabel ? (
        <div className="flex flex-none items-center border-l border-border/75 px-2">
          <button
            type="button"
            title={availableResetLabel}
            onClick={() => {
              onChoose?.();
              resetAsset(target);
              toast.success(
                builtin ? `${defaultName}已恢复为内置素材` : `${availableResetLabel}完成`,
              );
            }}
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-[11px] font-medium text-muted-foreground outline-none transition-colors hover:bg-white/[0.05] hover:text-foreground focus-visible:bg-white/[0.06] focus-visible:text-foreground"
          >
            <RotateCcw className="size-3.5" />
            {availableResetLabel}
          </button>
        </div>
      ) : null}

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
    </div>
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
    case "endingVideo":
      return config.ending.video.asset.kind === "upload" ? config.ending.video.asset.id : null;
  }
}

function isBuiltinAssetFor(
  target: AssetTarget,
  config: ReturnType<typeof useEditor.getState>["config"],
) {
  switch (target) {
    case "background":
      return config.content.background.kind === "builtin";
    case "mic":
      return config.content.mic.asset.kind === "builtin";
    case "device":
      return config.content.device.asset.kind === "builtin";
    case "teleVideo":
      return false;
    case "bgm":
      return config.content.bgm?.asset.kind === "builtin";
    case "sfx":
      return config.opening.curtain.sfx?.kind === "builtin";
    case "endingVideo":
      return config.ending.video.asset.kind === "builtin";
  }
}
