"use client";

import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useEditor } from "@/lib/store";

const num = (v: number | readonly number[]) => (Array.isArray(v) ? v[0] : (v as number));

// Classic stage-curtain velvets. First entry is the project default.
const CURTAIN_COLORS: { name: string; value: string }[] = [
  { name: "玫红", value: "#d11069" },
  { name: "经典红", value: "#9b1c2e" },
  { name: "宝蓝", value: "#1e3a8a" },
  { name: "翠绿", value: "#0f5132" },
  { name: "鎏金", value: "#b8860b" },
  { name: "紫绒", value: "#4c1d95" },
  { name: "墨黑", value: "#1f2937" },
];

export function OpeningPanel() {
  const titleText = useEditor((s) => s.config.opening.title.text);
  const titleFontSize = useEditor((s) => s.config.opening.title.fontSize);
  const countdownOn = useEditor((s) => s.config.opening.countdown.enabled);
  const countdownSpeed = useEditor((s) => s.config.opening.countdown.speed);
  const countdownFontSize = useEditor((s) => s.config.opening.countdown.fontSize);
  const curtainColor = useEditor((s) => s.config.opening.curtain.color);
  const setTitleText = useEditor((s) => s.setTitleText);
  const setTitleFontSize = useEditor((s) => s.setTitleFontSize);
  const toggleCountdown = useEditor((s) => s.toggleCountdown);
  const setCountdownSpeed = useEditor((s) => s.setCountdownSpeed);
  const setCountdownFontSize = useEditor((s) => s.setCountdownFontSize);
  const setCurtainColor = useEditor((s) => s.setCurtainColor);
  const setView = useEditor((s) => s.setView);

  const pickColor = (value: string) => {
    setCurtainColor(value);
    setView("opening");
  };
  const isPreset = CURTAIN_COLORS.some((c) => c.value.toLowerCase() === curtainColor.toLowerCase());

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
          <Textarea
            id="title"
            value={titleText}
            rows={2}
            placeholder="输入标题，按回车换行"
            onFocus={() => setView("opening")}
            onChange={(e) => setTitleText(e.target.value)}
          />
          <p className="text-[11px] text-muted-foreground">按回车换行，预览与导出会同样换行</p>
          <div className="flex items-center gap-3 pt-1">
            <span className="w-16 text-[11px] text-muted-foreground">标题字号</span>
            <Slider
              min={40}
              max={200}
              step={2}
              value={[titleFontSize]}
              onValueChange={(v) => { setTitleFontSize(num(v)); setView("opening"); }}
              className="flex-1"
            />
            <span className="w-10 text-right text-[11px] text-muted-foreground">
              {Math.round(titleFontSize)}px
            </span>
          </div>
        </div>

        <div className="flex items-center justify-between">
          <div className="text-[13px]">3·2·1 倒计时</div>
          <Switch checked={countdownOn} onCheckedChange={(v) => { toggleCountdown(v); setView("opening"); }} />
        </div>

        {countdownOn && (
          <div className="space-y-3">
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
            <div className="flex items-center gap-3">
              <span className="w-16 text-[11px] text-muted-foreground">倒计时字号</span>
              <Slider
                min={80}
                max={320}
                step={2}
                value={[countdownFontSize]}
                onValueChange={(v) => { setCountdownFontSize(num(v)); setView("opening"); }}
                className="flex-1"
              />
              <span className="w-10 text-right text-[11px] text-muted-foreground">
                {Math.round(countdownFontSize)}px
              </span>
            </div>
          </div>
        )}

        <div className="space-y-2">
          <Label className="text-xs">幕布颜色</Label>
          <div className="flex flex-wrap items-center gap-2">
            {CURTAIN_COLORS.map((c) => {
              const on = c.value.toLowerCase() === curtainColor.toLowerCase();
              return (
                <button
                  key={c.value}
                  type="button"
                  title={c.name}
                  aria-label={c.name}
                  aria-pressed={on}
                  onClick={() => pickColor(c.value)}
                  className={`size-7 rounded-full border transition-transform hover:scale-110 ${
                    on ? "border-white ring-2 ring-[#ff2d7e] ring-offset-2 ring-offset-card" : "border-white/20"
                  }`}
                  style={{ backgroundColor: c.value }}
                />
              );
            })}
            <label
              title="自定义颜色"
              className={`relative size-7 cursor-pointer overflow-hidden rounded-full border transition-transform hover:scale-110 ${
                isPreset ? "border-white/20" : "border-white ring-2 ring-[#ff2d7e] ring-offset-2 ring-offset-card"
              }`}
              style={{
                background: isPreset
                  ? "conic-gradient(from 0deg, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)"
                  : curtainColor,
              }}
            >
              <input
                type="color"
                value={curtainColor}
                onChange={(e) => pickColor(e.target.value)}
                className="absolute inset-0 cursor-pointer opacity-0"
              />
            </label>
          </div>
        </div>
      </div>
    </section>
  );
}
