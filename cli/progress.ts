export type ProgressSample = {
  /** Original progress reported by the underlying operation. */
  sourceRatio: number;
  /** Ratio mapped into the caller's overall workflow range. */
  ratio: number;
  percent: number;
};

export type ThrottledProgressOptions = {
  base?: number;
  span?: number;
  minimumPercentStep?: number;
};

/**
 * Deduplicates high-frequency renderer progress while preserving 0% and 100%.
 * The mapping lets a sub-operation occupy a stable slice of an overall
 * workflow without reimplementing throttling at each call site.
 */
export function createThrottledProgressReporter(
  report: (sample: ProgressSample) => void,
  options: ThrottledProgressOptions = {},
): (ratio: number) => void {
  const base = options.base ?? 0;
  const span = options.span ?? 1;
  const step = options.minimumPercentStep ?? 2;
  if (!Number.isFinite(base) || !Number.isFinite(span) || span < 0) {
    throw new Error("进度映射的 base/span 无效");
  }
  if (!Number.isInteger(step) || step < 1 || step > 100) {
    throw new Error("进度节流步长必须是 1 到 100 的整数");
  }

  let lastPercent = -1;
  return (rawRatio) => {
    const sourceRatio = Math.max(0, Math.min(1, rawRatio));
    const percent = Math.floor(sourceRatio * 100);
    if (percent < 100 && percent !== 0 && percent < lastPercent + step) return;
    if (percent === lastPercent) return;
    lastPercent = percent;
    report({
      sourceRatio,
      ratio: base + sourceRatio * span,
      percent,
    });
  };
}
