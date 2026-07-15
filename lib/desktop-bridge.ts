import type { ExportOptions } from "./export-options";

export const DESKTOP_UPDATE_CHANNELS = {
  getState: "updater:get-state",
  retry: "updater:retry",
  install: "updater:install",
  stateChanged: "updater:state-changed",
} as const;

export type DesktopUpdateErrorPhase = "check" | "download" | "install";

export type DesktopUpdateState = {
  revision: number;
  status:
    | "idle"
    | "checking"
    | "downloading"
    | "ready"
    | "installing"
    | "not-available"
    | "error"
    | "unsupported";
  currentVersion: string;
  targetVersion?: string;
  percent?: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
  errorPhase?: DesktopUpdateErrorPhase;
  errorCode?: string;
  message?: string;
  retryable?: boolean;
};

export type DesktopUpdateCommandResult =
  | { ok: true }
  | { ok: false; error: string; busy?: boolean };

export type DesktopRenderAsset = {
  id: string;
  name: string;
  mime: string;
  data: ArrayBuffer;
};

export type DesktopRenderBridge = {
  isAvailable: boolean;
  supportsExportOptions?: boolean;
  supportsEndingVideo?: boolean;
  supportsUpdateStatus?: boolean;
  beginExportSession?: () => Promise<{ ok: true; sessionId: string }>;
  endExportSession?: (sessionId: string) => Promise<{ ok: true }>;
  render: (payload: {
    serveUrl: string;
    config: unknown;
    assets: DesktopRenderAsset[];
    options: ExportOptions;
    sessionId?: string;
  }) => Promise<{ ok: true; jobId: string } | { ok: false; error: string }>;
  onProgress: (callback: (progress: number) => void) => () => void;
  cancel: (jobId: string) => Promise<{ ok: true }>;
  save: (
    jobId: string,
    kind: "video" | "cover",
  ) => Promise<{ ok: true; path: string } | { ok: false; canceled?: boolean; error?: string }>;
  reveal: (filePath: string) => Promise<{ ok: true }>;
  cleanup: (jobId: string) => Promise<{ ok: true }>;
  getUpdateState?: () => Promise<DesktopUpdateState>;
  retryUpdate?: () => Promise<DesktopUpdateCommandResult>;
  restartAndInstall?: () => Promise<DesktopUpdateCommandResult>;
  onUpdateState?: (callback: (state: DesktopUpdateState) => void) => () => void;
};

export type DesktopUpdateGateMode = "hidden" | "manual" | "legacy-auto" | "observable";

type DesktopBridgeCapabilities = Pick<
  DesktopRenderBridge,
  "isAvailable" | "supportsExportOptions" | "supportsEndingVideo" | "supportsUpdateStatus"
>;

export function classifyDesktopUpdateGate(
  bridge?: Partial<DesktopBridgeCapabilities>,
): DesktopUpdateGateMode {
  if (!bridge?.isAvailable) return "hidden";
  if (bridge.supportsUpdateStatus) return "observable";
  if (bridge.supportsEndingVideo || bridge.supportsExportOptions) return "legacy-auto";
  return "manual";
}

/**
 * Capability flags are the only version signal exposed by clients released
 * before the update-status protocol. These values describe the first release
 * that shipped each cumulative capability; observable clients replace the
 * fallback with app.getVersion() from their status snapshot.
 */
export function inferDesktopClientVersion(
  bridge?: Partial<DesktopBridgeCapabilities>,
): string | null {
  if (!bridge?.isAvailable) return null;
  if (bridge.supportsUpdateStatus) return "0.2.2";
  if (bridge.supportsEndingVideo) return "0.2.1";
  if (bridge.supportsExportOptions) return "0.2.0";
  return "0.1.0";
}

type ParsedDesktopVersion = {
  core: [number, number, number];
  prerelease: string[] | null;
};

function parseDesktopVersion(version: string): ParsedDesktopVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    version.trim(),
  );
  if (!match) return null;
  const core = match.slice(1, 4).map(Number) as [number, number, number];
  if (core.some((part) => !Number.isSafeInteger(part))) return null;
  return { core, prerelease: match[4]?.split(".") ?? null };
}

function comparePrerelease(left: string[] | null, right: string[] | null): -1 | 0 | 1 {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;

  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) return Number(a) < Number(b) ? -1 : 1;
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

export function compareDesktopVersions(left: string, right: string): -1 | 0 | 1 | null {
  const a = parseDesktopVersion(left);
  const b = parseDesktopVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < a.core.length; index += 1) {
    if (a.core[index] === b.core[index]) continue;
    return a.core[index] < b.core[index] ? -1 : 1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

export function shouldBlockDesktopUpdate({
  mode,
  releaseRequired,
  currentVersion,
  requiredVersion,
}: {
  mode: DesktopUpdateGateMode;
  releaseRequired: boolean;
  currentVersion: string | null | undefined;
  requiredVersion: string;
}): boolean {
  return (
    mode !== "hidden" &&
    releaseRequired &&
    typeof currentVersion === "string" &&
    compareDesktopVersions(currentVersion, requiredVersion) === -1
  );
}

declare global {
  interface Window {
    electronRender?: DesktopRenderBridge;
  }
}
