export type UpdateRestartGuard = {
  isCommitted: () => boolean;
  hasActiveRestartBlocker: () => boolean;
  tryAcquireRestartBlocker: () => (() => void) | null;
  commit: () => boolean;
  release: () => void;
};

export function createUpdateRestartGuard(): UpdateRestartGuard {
  let committed = false;
  const restartBlockers = new Set<symbol>();
  return {
    isCommitted: () => committed,
    hasActiveRestartBlocker: () => restartBlockers.size > 0,
    tryAcquireRestartBlocker: () => {
      if (committed) return null;
      const token = Symbol("update-restart-blocker");
      restartBlockers.add(token);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        restartBlockers.delete(token);
      };
    },
    commit: () => {
      if (committed || restartBlockers.size > 0) return false;
      committed = true;
      return true;
    },
    release: () => {
      committed = false;
    },
  };
}

// Shared by updater, render and CLI-install IPC. Because these handlers run on
// Electron's main thread, committing the restart latch or acquiring a blocker
// is atomic with respect to the other IPC callbacks. Blockers are tokenized so
// an old async finalizer cannot release a newer operation's lease.
export const updateRestartGuard = createUpdateRestartGuard();
