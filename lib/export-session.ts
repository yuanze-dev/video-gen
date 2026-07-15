import { useSyncExternalStore } from "react";

export type ExportSessionActivityStore = {
  acquire: () => () => void;
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => boolean;
};

export function createExportSessionActivityStore(): ExportSessionActivityStore {
  const leases = new Set<symbol>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };

  return {
    acquire: () => {
      const lease = Symbol("export-session");
      const wasActive = leases.size > 0;
      leases.add(lease);
      if (!wasActive) notify();

      let released = false;
      return () => {
        if (released) return;
        released = true;
        const wasActiveBeforeRelease = leases.size > 0;
        leases.delete(lease);
        if (wasActiveBeforeRelease && leases.size === 0) notify();
      };
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => leases.size > 0,
  };
}

const exportSessionActivity = createExportSessionActivityStore();

export function acquireExportSessionActivity(): () => void {
  return exportSessionActivity.acquire();
}

export function useExportSessionActive(): boolean {
  return useSyncExternalStore(
    exportSessionActivity.subscribe,
    exportSessionActivity.getSnapshot,
    () => false,
  );
}
