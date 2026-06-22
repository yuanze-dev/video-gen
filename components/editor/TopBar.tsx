"use client";

import { useRef } from "react";
import { toast } from "sonner";
import { RotateCcw, FileUp, FileDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ExportDialog } from "./ExportDialog";
import { useEditor } from "@/lib/store";

export function TopBar() {
  const resetConfig = useEditor((s) => s.resetConfig);
  const exportJson = useEditor((s) => s.exportJson);
  const importJson = useEditor((s) => s.importJson);
  const jsonInputRef = useRef<HTMLInputElement>(null);

  const doExportJson = () => {
    const blob = new Blob([exportJson()], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "teleprompter-config.json";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <header className="flex h-14 flex-none items-center gap-3 border-b border-border bg-gradient-to-b from-[#17171e] to-[#121218] px-4">
      <div className="flex items-center gap-2.5">
        <div className="grid size-8 place-items-center rounded-lg bg-gradient-to-br from-[#ff5ba0] to-[#ff2d7e] text-base shadow-lg shadow-[#ff2d7e]/40">
          🎤
        </div>
        <span className="text-sm font-semibold leading-none">小音符起号助手</span>
      </div>

      <div className="flex-1" />

      <Button variant="ghost" size="sm" onClick={() => jsonInputRef.current?.click()} title="导入配置 JSON">
        <FileUp className="size-4" /> 导入
      </Button>
      <Button variant="ghost" size="sm" onClick={doExportJson} title="导出配置 JSON">
        <FileDown className="size-4" /> 导出配置
      </Button>
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
