"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { useEditor } from "@/lib/store";

const num = (v: number | readonly number[]) => (Array.isArray(v) ? v[0] : (v as number));

export function OpeningPanel() {
  const titleText = useEditor((s) => s.config.opening.title.text);
  const countdownOn = useEditor((s) => s.config.opening.countdown.enabled);
  const countdownSpeed = useEditor((s) => s.config.opening.countdown.speed);
  const setTitleText = useEditor((s) => s.setTitleText);
  const toggleCountdown = useEditor((s) => s.toggleCountdown);
  const setCountdownSpeed = useEditor((s) => s.setCountdownSpeed);
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

        {countdownOn && (
          <div className="flex items-center gap-3">
            <span className="w-16 text-[11px] text-muted-foreground">倒计时速度</span>
            <Slider
              min={0.5}
              max={3}
              step={0.1}
              value={[countdownSpeed]}
              onValueChange={(v) => { setCountdownSpeed(num(v)); setView("opening"); }}
              className="flex-1"
            />
            <span className="w-10 text-right text-[11px] text-muted-foreground">
              {countdownSpeed.toFixed(1)}×
            </span>
          </div>
        )}
      </div>
    </section>
  );
}
