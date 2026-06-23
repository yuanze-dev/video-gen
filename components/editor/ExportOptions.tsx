// No "use client" directive: this is a presentational leaf rendered only inside
// the client-side ExportDialog, so it's bundled as client code without becoming
// its own server/client boundary (which would forbid the onChange function prop).
import { cn } from "@/lib/utils";
import type {
  ExportFps,
  ExportOptions,
  ExportQuality,
  ExportResolution,
} from "@/lib/export-options";

// A single segmented choice: full-width buttons, accent border when active.
function Segmented<T extends string | number>({
  value,
  onChange,
  options,
  disabled,
}: {
  value: T;
  onChange: (next: T) => void;
  options: { value: T; label: string; hint?: string }[];
  disabled?: boolean;
}) {
  return (
    <div className="flex gap-2">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            disabled={disabled}
            onClick={() => onChange(o.value)}
            aria-pressed={active}
            className={cn(
              "flex-1 rounded-lg border px-3 py-2 text-left transition disabled:opacity-50",
              active
                ? "border-[#ff2d7e] bg-[#ff2d7e]/10 text-foreground"
                : "border-border bg-muted/30 text-muted-foreground hover:border-foreground/40",
            )}
          >
            <div className="text-[13px] font-medium leading-tight">{o.label}</div>
            {o.hint ? <div className="mt-0.5 text-[11px] leading-tight opacity-70">{o.hint}</div> : null}
          </button>
        );
      })}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="text-[12px] font-medium text-foreground">{label}</div>
      {children}
    </div>
  );
}

// Plain-language export settings for non-technical users. Each control maps to
// an encoder setting in lib/export-options, but the labels stay outcome-based.
export function ExportOptionsForm({
  value,
  onChange,
  disabled,
}: {
  value: ExportOptions;
  onChange: (next: ExportOptions) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-3">
      <Field label="画质">
        <Segmented<ExportQuality>
          value={value.quality}
          onChange={(quality) => onChange({ ...value, quality })}
          disabled={disabled}
          options={[
            { value: "high", label: "高清", hint: "画质最佳" },
            { value: "standard", label: "标准", hint: "体积更小" },
            { value: "small", label: "省流量", hint: "文件最小" },
          ]}
        />
      </Field>

      <Field label="清晰度">
        <Segmented<ExportResolution>
          value={value.resolution}
          onChange={(resolution) => onChange({ ...value, resolution })}
          disabled={disabled}
          options={[
            { value: "1080p", label: "1080P 超清", hint: "推荐" },
            { value: "720p", label: "720P", hint: "导出更快、更小" },
          ]}
        />
      </Field>

      <Field label="流畅度">
        <Segmented<ExportFps>
          value={value.fps}
          onChange={(fps) => onChange({ ...value, fps })}
          disabled={disabled}
          options={[
            { value: 60, label: "60 帧", hint: "更流畅" },
            { value: 30, label: "30 帧", hint: "体积更小" },
          ]}
        />
      </Field>
    </div>
  );
}
