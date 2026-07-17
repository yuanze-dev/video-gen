// Shared layout constants. The Remotion composition renders in logical canvas
// pixels (1080x1920); the editor preview scales the whole thing down.

export const CANVAS = { width: 1080, height: 1920, fps: 60 } as const;

// Base sizes (px at scale=1) for draggable elements, expressed in canvas pixels.
export const MIC_BASE_W = 360; // microphone graphic width
export const MIC_ASPECT = 940 / 1060; // h / w of the built-in mic image

export const DEVICE_BASE_W = 820; // teleprompter device (hand + phone) width
export const DEVICE_ASPECT = 2438 / 1798; // h / w of the built-in device image

// Teleprompter text scroll speed (px per second at speed multiplier = 1).
export const PX_PER_SEC = 130;

// Minimum content duration so very short text still gets screen time.
export const MIN_CONTENT_SEC = 6;
export const MAX_CONTENT_SEC = 600;

export const ACCENT = "#ff2d7e";

// The Remotion entrypoint bundles this OFL font, keeping CLI renders identical
// across macOS, Windows, Linux and headless containers.
export const FONT_STACK = '"Noto Sans SC Variable", Arial, sans-serif';
