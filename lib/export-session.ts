import { useSyncExternalStore } from "react";

let active = false;
const listeners = new Set<() => void>();

export function setExportSessionActive(next: boolean): void {
  if (active === next) return;
  active = next;
  for (const listener of listeners) listener();
}

export function useExportSessionActive(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => active,
    () => false,
  );
}
