"use client";

import type { ReactNode } from "react";
import { ChevronDown, Eye } from "lucide-react";
import { cn } from "@/lib/utils";
import { useEditor, type SceneView } from "@/lib/store";

export function StagePanel({
  stage,
  step,
  title,
  description,
  children,
}: {
  stage: SceneView;
  step: number;
  title: string;
  description: string;
  children: ReactNode;
}) {
  const view = useEditor((s) => s.view);
  const focusView = useEditor((s) => s.focusView);
  const active = view === stage;
  const triggerId = `stage-${stage}-trigger`;
  const panelId = `stage-${stage}-panel`;

  return (
    <section
      className={cn(
        "relative z-10 overflow-hidden rounded-2xl border bg-card/95 shadow-[0_14px_40px_rgba(0,0,0,0.12)] transition-[border-color,box-shadow] duration-200",
        active
          ? "border-[#ff2d7e]/55 shadow-[0_18px_55px_rgba(255,45,126,0.08)]"
          : "border-border/90 hover:border-white/20",
      )}
    >
      <h2>
        <button
          id={triggerId}
          type="button"
          aria-controls={panelId}
          aria-expanded={active}
          onClick={() => focusView(stage)}
          className="group flex w-full items-center gap-3 px-5 py-4 text-left outline-none transition-colors hover:bg-white/[0.025] focus-visible:bg-white/[0.04] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#ff2d7e]/70"
        >
          <span
            className={cn(
              "grid size-7 flex-none place-items-center rounded-full border text-xs font-bold transition-all",
              active
                ? "border-[#ff2d7e] bg-[#ff2d7e] text-white shadow-[0_0_18px_rgba(255,45,126,0.35)]"
                : "border-white/10 bg-white/[0.045] text-muted-foreground group-hover:text-foreground",
            )}
          >
            {step}
          </span>

          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold tracking-[0.01em]">{title}</span>
            <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
              {description}
            </span>
          </span>

          {active ? (
            <span className="flex flex-none items-center gap-1 rounded-full bg-[#ff2d7e]/10 px-2.5 py-1 text-[10px] font-medium text-[#ff6da5]">
              <Eye className="size-3" />
              正在编辑
            </span>
          ) : (
            <ChevronDown
              aria-hidden="true"
              className="size-4 -rotate-90 text-muted-foreground transition-transform group-hover:translate-x-0.5"
            />
          )}
        </button>
      </h2>

      <div
        id={panelId}
        role="region"
        aria-labelledby={triggerId}
        hidden={!active}
        className="border-t border-border/75 bg-black/[0.055] p-5 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-1 motion-safe:duration-200"
      >
        {children}
      </div>
    </section>
  );
}
