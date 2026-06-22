"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useEditor } from "@/lib/store";

export function OpeningPanel() {
  const titleText = useEditor((s) => s.config.opening.title.text);
  const countdownOn = useEditor((s) => s.config.opening.countdown.enabled);
  const setTitleText = useEditor((s) => s.setTitleText);
  const toggleCountdown = useEditor((s) => s.toggleCountdown);
  const setView = useEditor((s) => s.setView);

  return (
    <section className="rounded-2xl border border-border bg-card p-5">
      <header className="mb-4 flex items-center gap-2.5">
        <span className="grid size-5 place-items-center rounded-full bg-[#ff2d7e] text-[11px] font-bold text-white">
          1
        </span>
        <h2 className="text-sm font-semibold">开场</h2>
      </header>

      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="title" className="text-xs">标题文字</Label>
          <Input
            id="title"
            value={titleText}
            onFocus={() => setView("opening")}
            onChange={(e) => setTitleText(e.target.value)}
          />
        </div>

        <div className="flex items-center justify-between">
          <div className="text-[13px]">3·2·1 倒计时</div>
          <Switch checked={countdownOn} onCheckedChange={(v) => { toggleCountdown(v); setView("opening"); }} />
        </div>
      </div>
    </section>
  );
}
