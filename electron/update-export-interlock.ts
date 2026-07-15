import type { UpdateRestartGuard } from "./update-restart-guard.ts";

export const UPDATE_RESTART_EXPORT_ERROR = "应用正在重启更新，暂时无法开始新的导出";

export function beginExportWithUpdateInterlock(
  restartGuard: UpdateRestartGuard,
  begin: () => string,
): { ok: true; sessionId: string } | { ok: false; error: string } {
  if (restartGuard.isCommitted()) {
    return { ok: false, error: UPDATE_RESTART_EXPORT_ERROR };
  }

  // The guard check and reservation callback stay in one synchronous stack.
  // Electron's main-thread event loop cannot run an install IPC between them.
  return { ok: true, sessionId: begin() };
}

export function startRenderWithUpdateInterlock<Result>(
  restartGuard: UpdateRestartGuard,
  start: () => Promise<Result>,
): Promise<Result> {
  if (restartGuard.isCommitted()) {
    throw new Error(UPDATE_RESTART_EXPORT_ERROR);
  }

  // Calling an async function executes it synchronously through its first
  // await. startRender registers its job in that section, closing the other
  // ordering of the restart/export race.
  return start();
}
