// Preload — exposes a narrow, validated render bridge to the remote page.
// The editor (loaded from Vercel) detects `window.electronRender` and routes
// MP4 export through it; in a plain browser the object is absent.
import { contextBridge, ipcRenderer } from "electron";

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
};

const electronRender = {
  isAvailable: true as const,

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
