"use client";

import { useRef, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { RotateCcw, FileUp, FileDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ExportDialog } from "./ExportDialog";
import { CliInstallDialog } from "./CliInstallDialog";
import { DesktopUpdateIndicator } from "./DesktopUpdateIndicator";
import { Logo } from "./Logo";
import { useEditor } from "@/lib/store";
import { cn } from "@/lib/utils";

// Whether we're running inside the Electron desktop shell. The preload injects
// `window.electronRender` before page scripts run, so this is stable for the
// page's lifetime — read it via useSyncExternalStore (never-changing store) so
// SSR returns false and the client picks up the real value without a hydration
// mismatch or a layout flash.
const noopSubscribe = () => () => {};
function useIsDesktop() {
  return useSyncExternalStore(
    noopSubscribe,
    () => !!window.electronRender,
    () => false,
  );
}

function useSupportsCliInstall() {
  return useSyncExternalStore(
    noopSubscribe,
    () =>
      window.electronRender?.supportsCliInstall === true &&
      typeof window.electronRender.getCliInstallState === "function" &&
      typeof window.electronRender.installCli === "function",
    () => false,
  );
}

export function TopBar() {
  const resetConfig = useEditor((s) => s.resetConfig);
  const exportJson = useEditor((s) => s.exportJson);
  const importJson = useEditor((s) => s.importJson);
  const jsonInputRef = useRef<HTMLInputElement>(null);

  // In the desktop shell the native title bar is hidden, so the macOS traffic
  // lights float over the top-left of this header. When desktop, (a) let the
  // bar drag the window and (b) inset the logo clear of the lights.
  const isDesktop = useIsDesktop();
  const supportsCliInstall = useSupportsCliInstall();

  const doExportJson = () => {
    const blob = new Blob([exportJson()], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "teleprompter-config.json";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <header
      className={cn(
        "flex h-14 flex-none items-center gap-3 border-b border-border bg-gradient-to-b from-[#17171e] to-[#121218]",
        // Desktop: drag the window from the bar; inset the logo past the
        // floating traffic lights. Browser: standard symmetric padding.
        isDesktop ? "drag-region pl-[88px] pr-4" : "px-4",
      )}
    >
      <div className="flex shrink-0 items-center gap-2.5">
        <Logo className="size-8 rounded-lg shadow-lg shadow-[#ff2d7e]/40" />
        <span className="text-sm font-semibold leading-none">小音符起号助手</span>
      </div>

      <div className="flex min-w-0 flex-1 justify-center px-2">
        <DesktopUpdateIndicator />
      </div>

      <div className={cn("flex items-center gap-3", isDesktop && "no-drag-region")}>
        <Button variant="ghost" size="sm" onClick={() => jsonInputRef.current?.click()} title="导入配置 JSON">
          <FileUp className="size-4" /> 导入
        </Button>
        <Button variant="ghost" size="sm" onClick={doExportJson} title="导出配置 JSON">
          <FileDown className="size-4" /> 导出配置
        </Button>
        {supportsCliInstall ? <CliInstallDialog /> : null}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            if (confirm("重置为默认模板？当前内容会丢失。")) resetConfig();
          }}
        >
          <RotateCcw className="size-4" /> 重置
        </Button>
        <ExportDialog />
      </div>

      <input
        ref={jsonInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          const r = importJson(await f.text());
          if (r.ok) toast.success("配置已导入");
          else toast.error(r.error ?? "导入失败");
        }}
      />
    </header>
  );
}
