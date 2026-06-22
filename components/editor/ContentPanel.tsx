"use client";

import { Image as ImageIcon, Film, Music } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Uploader } from "./Uploader";
import { useEditor } from "@/lib/store";

const num = (v: number | readonly number[]) => (Array.isArray(v) ? v[0] : (v as number));

export function ContentPanel() {
  const mode = useEditor((s) => s.config.content.teleprompter.mode);
  const text = useEditor((s) => s.config.content.teleprompter.text);
  const keepAudio = useEditor((s) => s.config.content.teleprompter.video?.keepAudio ?? true);
  const bgm = useEditor((s) => s.config.content.bgm);

  const setTeleMode = useEditor((s) => s.setTeleMode);
  const setTeleText = useEditor((s) => s.setTeleText);
  const setTeleSpeed = useEditor((s) => s.setTeleSpeed);
  const setKeepAudio = useEditor((s) => s.setKeepAudio);
  const setBgmVolume = useEditor((s) => s.setBgmVolume);
  const setView = useEditor((s) => s.setView);

  return (
    <section className="rounded-2xl border border-border bg-card p-5">
      <header className="mb-4 flex items-center gap-2.5">
        <span className="grid size-5 place-items-center rounded-full bg-[#ff2d7e] text-[11px] font-bold text-white">
          2
        </span>
        <h2 className="text-sm font-semibold">正片</h2>
      </header>

      <div className="space-y-5">
        <div className="space-y-2">
          <Label className="text-xs">背景图</Label>
          <Uploader target="background" accept="image/*" icon={<ImageIcon className="size-4" />} defaultName="机场登机口（内置）" hint="点击上传图片" />
        </div>

        <div className="space-y-2">
          <Label className="text-xs">提词内容</Label>
          <Tabs value={mode} onValueChange={(v) => { setTeleMode(v as "text" | "video"); setView("content"); }}>
            <TabsList className="w-full">
              <TabsTrigger value="text" className="flex-1">输入文字</TabsTrigger>
              <TabsTrigger value="video" className="flex-1">上传视频</TabsTrigger>
            </TabsList>
          </Tabs>

          {mode === "text" ? (
            <div className="space-y-3 pt-1">
              <Textarea
                value={text?.content ?? ""}
                onFocus={() => setView("content")}
                onChange={(e) => setTeleText(e.target.value)}
                className="min-h-28"
              />
              <div className="flex items-center gap-3">
                <span className="w-16 text-[11px] text-muted-foreground">滚动速度</span>
                <Slider
                  min={0.3}
                  max={3}
                  step={0.1}
                  value={[text?.speed ?? 1]}
                  onValueChange={(v) => setTeleSpeed(num(v))}
                  className="flex-1"
                />
                <span className="w-10 text-right text-[11px] text-muted-foreground">
                  {(text?.speed ?? 1).toFixed(1)}×
                </span>
              </div>
            </div>
          ) : (
            <div className="space-y-3 pt-1">
              <Uploader target="teleVideo" accept="video/*" icon={<Film className="size-4" />} defaultName="未上传视频" hint="点击上传视频" />
              <div className="flex items-center justify-between">
                <span className="text-[13px]">保留视频原声</span>
                <Switch checked={keepAudio} onCheckedChange={setKeepAudio} />
              </div>
            </div>
          )}
        </div>

        <div className="space-y-2">
          <Label className="text-xs">背景音乐</Label>
          <Uploader target="bgm" accept="audio/*" icon={<Music className="size-4" />} defaultName="无背景音乐" hint="点击上传音频" />
          {bgm ? (
            <div className="flex items-center gap-3 pt-1">
              <span className="w-16 text-[11px] text-muted-foreground">音量</span>
              <Slider min={0} max={1} step={0.05} value={[bgm.volume]} onValueChange={(v) => setBgmVolume(num(v))} className="flex-1" />
              <span className="w-10 text-right text-[11px] text-muted-foreground">{Math.round(bgm.volume * 100)}</span>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
