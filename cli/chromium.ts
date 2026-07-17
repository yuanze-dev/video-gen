export const CHROMIUM_GL_RENDERERS = ["angle", "swangle"] as const;

export type ChromiumGlRenderer = (typeof CHROMIUM_GL_RENDERERS)[number];

export class ChromiumGlConfigurationError extends Error {
  readonly value: string;

  constructor(value: string) {
    super(
      `LITTLESTART_CHROMIUM_GL 必须是 ${CHROMIUM_GL_RENDERERS.join(" | ")}，当前为 "${value}"`,
    );
    this.name = "ChromiumGlConfigurationError";
    this.value = value;
  }
}

/**
 * Selects the Chromium WebGL backend used by both diagnostics and rendering.
 * `angle` remains the native/default path; headless containers can opt into
 * ANGLE's deterministic SwiftShader backend with `swangle`.
 */
export function resolveChromiumGlRenderer(
  env: NodeJS.ProcessEnv = process.env,
): ChromiumGlRenderer {
  const configured = env.LITTLESTART_CHROMIUM_GL?.trim();
  if (!configured) return "angle";
  if ((CHROMIUM_GL_RENDERERS as readonly string[]).includes(configured)) {
    return configured as ChromiumGlRenderer;
  }
  throw new ChromiumGlConfigurationError(configured);
}
