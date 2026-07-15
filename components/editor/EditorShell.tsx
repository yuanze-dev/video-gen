"use client";

import { useEffect, useRef } from "react";
import { TopBar } from "./TopBar";
import { OpeningPanel } from "./OpeningPanel";
import { ContentPanel } from "./ContentPanel";
import { EndingPanel } from "./EndingPanel";
import { RequiredUpdateGate } from "./RequiredUpdateGate";
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
      <div className="grid min-h-0 flex-1 grid-cols-[clamp(540px,44vw,680px)_minmax(420px,1fr)]">
        <aside className="editor-scrollbar min-h-0 overflow-y-auto overscroll-contain border-r border-border bg-[linear-gradient(180deg,rgba(255,45,126,0.025),transparent_220px)]">
          <div className="mx-auto w-full max-w-[640px] px-6 py-5">
            <header className="mb-5 border-b border-border/75 pb-5">
              <div className="mb-2 flex items-center justify-between gap-4">
                <div className="flex items-center gap-2.5">
                  <span className="h-px w-5 bg-[#ff2d7e]" />
                  <h1 className="text-base font-semibold tracking-[0.01em]">视频流程</h1>
                </div>
                <span className="rounded-full border border-white/10 bg-white/[0.035] px-2.5 py-1 text-[10px] font-medium text-muted-foreground">
                  3 段结构
                </span>
              </div>
              <p className="max-w-[520px] text-xs leading-relaxed text-muted-foreground">
                按顺序设置开场、正片和片尾。当前卡片会同步到右侧预览；麦克风和手机可直接拖动调整。
              </p>
            </header>

            <div className="relative space-y-3 before:absolute before:bottom-8 before:left-[33px] before:top-8 before:w-px before:bg-gradient-to-b before:from-[#ff2d7e]/35 before:via-white/10 before:to-white/5">
              <OpeningPanel />
              <ContentPanel />
              <EndingPanel />
            </div>
          </div>
        </aside>
        <main className="min-h-0 min-w-0 overflow-hidden bg-[radial-gradient(700px_500px_at_50%_0%,#1a1a23,transparent)]">
          <Preview />
        </main>
      </div>
      <RequiredUpdateGate />
    </div>
  );
}
