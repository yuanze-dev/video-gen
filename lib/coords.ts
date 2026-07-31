import { CANVAS, MIC_BASE_W, MIC_ASPECT, DEVICE_BASE_W, DEVICE_ASPECT } from "./constants";

export type Box = { left: number; top: number; width: number; height: number };

// Compute the pixel bounding box (in canvas px) of a centered element.
export function boxFor(
  transform: { x: number; y: number; scale: number },
  baseW: number,
  aspectHbyW: number,
): Box {
  const width = baseW * transform.scale;
  const height = width * aspectHbyW;
  return {
    width,
    height,
    left: transform.x * CANVAS.width - width / 2,
    top: transform.y * CANVAS.height - height / 2,
  };
}

export const micBox = (t: { x: number; y: number; scale: number }) =>
  boxFor(t, MIC_BASE_W, MIC_ASPECT);

export const deviceBox = (t: {
  x: number;
  y: number;
  scale: number;
  aspectRatio?: number;
}) => boxFor(t, DEVICE_BASE_W, t.aspectRatio ?? DEVICE_ASPECT);

export const deviceSize = (scale: number) => ({
  width: DEVICE_BASE_W * scale,
  height: DEVICE_BASE_W * scale * DEVICE_ASPECT,
});

export const micSize = (scale: number) => ({
  width: MIC_BASE_W * scale,
  height: MIC_BASE_W * scale * MIC_ASPECT,
});
