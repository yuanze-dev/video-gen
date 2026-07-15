export type UpdateRestartGuard = {
  isCommitted: () => boolean;
  commit: () => boolean;
  release: () => void;
};

export function createUpdateRestartGuard(): UpdateRestartGuard {
  let committed = false;
  return {
    isCommitted: () => committed,
    commit: () => {
      if (committed) return false;
      committed = true;
      return true;
    },
    release: () => {
      committed = false;
    },
  };
}

// Shared by updater IPC and render IPC. Because both handlers run on Electron's
// main thread, committing this latch and checking it around export reservation
// creation is atomic with respect to other IPC callbacks.
export const updateRestartGuard = createUpdateRestartGuard();
