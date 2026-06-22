"use client";

import { useEffect, useRef } from "react";
import { TopBar } from "./TopBar";
import { OpeningPanel } from "./OpeningPanel";
import { ContentPanel } from "./ContentPanel";
import { Preview } from "@/components/preview/Preview";
import { useEditor } from "@/lib/store";
import { ProjectConfig } from "@/lib/config-schema";

const STORAGE_KEY = "teleprompter:config";

export function EditorShell() {
  const config = useEditor((s) => s.config);
  const loadConfig = useEditor((s) => s.loadConfig);
  const hydrated = useRef(false);

  // load saved config once
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = ProjectConfig.safeParse(JSON.parse(raw));
        if (parsed.success) loadConfig(parsed.data);
      }
    } catch {
      // ignore corrupt storage
    }
    hydrated.current = true;
  }, [loadConfig]);

  // autosave config (uploaded assets are not persisted — they fall back to built-ins)
  useEffect(() => {
    if (!hydrated.current) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    } catch {
      // ignore quota errors
    }
  }, [config]);

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <TopBar />
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_clamp(420px,30vw,480px)]">
        <aside className="min-h-0 overflow-y-auto border-r border-border p-6">
          <p className="mb-5 text-xs leading-relaxed text-muted-foreground">
            填好下面几项就能出片。麦克风和手机的位置、大小，直接在右边预览里拖。
          </p>
          <div className="grid items-start gap-4 [grid-template-columns:repeat(auto-fit,minmax(320px,1fr))]">
            <OpeningPanel />
            <ContentPanel />
          </div>
        </aside>
        <main className="min-h-0 bg-[radial-gradient(700px_500px_at_50%_0%,#1a1a23,transparent)]">
          <Preview />
        </main>
      </div>
    </div>
  );
}
