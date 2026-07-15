// Preload — exposes a narrow, validated render bridge to the remote page.
// The editor (loaded from Vercel) detects `window.electronRender` and routes
// MP4 export through it; in a plain browser the object is absent.
import { contextBridge, ipcRenderer } from "electron";
import type { ExportOptions } from "../lib/export-options";

export type BridgeAsset = {
  id: string;
  name: string;
  mime: string;
  data: ArrayBuffer;
};

export type RenderPayload = {
  serveUrl: string;
  config: unknown;
  assets: BridgeAsset[];
  options?: ExportOptions;
  sessionId?: string;
};

const electronRender = {
  isAvailable: true as const,
  // Advertises that this shell's render engine honors the `options` payload
  // (画质/清晰度/流畅度). A freshly deployed web UI checks this so it can hide the
  // option picker from an OLDER installed shell that would silently ignore it,
  // instead of offering controls that do nothing until the user auto-updates.
  supportsExportOptions: true as const,
  // A remote editor can use this to avoid silently dropping a custom ending
  // when paired with an older installed shell whose resolver predates it.
  supportsEndingVideo: true as const,

  beginExportSession: (): Promise<{ ok: true; sessionId: string }> =>
    ipcRenderer.invoke("render:session-begin"),

  endExportSession: (sessionId: string): Promise<{ ok: true }> =>
    ipcRenderer.invoke("render:session-end", sessionId),

  render: (payload: RenderPayload): Promise<{ ok: true; jobId: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke("render:start", payload),

  onProgress: (cb: (progress: number) => void): (() => void) => {
    const handler = (_e: unknown, progress: number) => cb(progress);
    ipcRenderer.on("render:progress", handler);
    return () => ipcRenderer.off("render:progress", handler);
  },

  cancel: (jobId: string): Promise<{ ok: true }> => ipcRenderer.invoke("render:cancel", jobId),

  save: (
    jobId: string,
    kind: "video" | "cover",
  ): Promise<{ ok: true; path: string } | { ok: false; canceled?: boolean; error?: string }> =>
    ipcRenderer.invoke("render:save", { jobId, kind }),

  reveal: (filePath: string): Promise<{ ok: true }> => ipcRenderer.invoke("render:reveal", filePath),

  cleanup: (jobId: string): Promise<{ ok: true }> => ipcRenderer.invoke("render:cleanup", jobId),
};

contextBridge.exposeInMainWorld("electronRender", electronRender);

export type ElectronRender = typeof electronRender;
