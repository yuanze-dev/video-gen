"use client";

import { Film } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Uploader } from "./Uploader";
import { useEditor } from "@/lib/store";
import { StagePanel } from "./StagePanel";

export function EndingPanel() {
  const setView = useEditor((s) => s.setView);

  return (
    <StagePanel
      stage="ending"
      step={3}
      title="片尾"
      description="默认随每条视频导出的品牌片尾"
    >
      <div className="space-y-2">
        <Label className="text-xs">片尾视频</Label>
        <Uploader
          target="endingVideo"
          accept="video/*"
          icon={<Film className="size-4" />}
          defaultName="FlowPrompter 片尾"
          hint="点击上传视频替换"
          builtin
          onChoose={() => setView("ending")}
        />
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          默认随每条视频导出，完整保留片尾原声；替换视频会自动读取时长。
        </p>
      </div>
    </StagePanel>
  );
}
