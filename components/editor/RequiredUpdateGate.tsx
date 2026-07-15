"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { RefreshCw } from "lucide-react";
import { useExportSessionActive } from "@/lib/export-session";
import { Logo } from "./Logo";

const noopSubscribe = () => () => {};
const POLL_MS = 15_000;

function useOutdatedDesktop() {
  return useSyncExternalStore(
    noopSubscribe,
    () =>
      Boolean(
        window.electronRender?.isAvailable &&
          !window.electronRender.supportsEndingVideo,
      ),
    () => false,
  );
}

export function RequiredUpdateGate() {
  const outdatedDesktop = useOutdatedDesktop();
  const exportSessionActive = useExportSessionActive();
  const [releaseReady, setReleaseReady] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (!outdatedDesktop || releaseReady) return;

    let disposed = false;
    const check = async () => {
      try {
        const response = await fetch("/api/desktop-release", { cache: "no-store" });
        const data = (await response.json()) as { required?: boolean };
        if (!disposed && data.required) setReleaseReady(true);
      } catch {
        // Keep the editor usable during a transient release-status outage.
      }
    };

    void check();
    const timer = window.setInterval(() => void check(), POLL_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [outdatedDesktop, releaseReady]);

  const shouldBlock = outdatedDesktop && releaseReady && !exportSessionActive;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!shouldBlock || !dialog || dialog.open) return;
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, [shouldBlock]);

  if (!shouldBlock) return null;

  return (
    <dialog
      ref={dialogRef}
      className="fixed inset-0 m-0 h-screen max-h-none w-screen max-w-none border-0 bg-[#09090d]/98 p-0 text-inherit backdrop:bg-[#09090d]/98"
      role="alertdialog"
      aria-labelledby="required-update-title"
      aria-describedby="required-update-description"
      onCancel={(event) => event.preventDefault()}
    >
      <div className="grid h-full w-full place-items-center px-6">
        <div className="w-full max-w-[460px] rounded-2xl border border-white/10 bg-[#17171e] p-8 text-center shadow-2xl shadow-black/60">
          <Logo className="mx-auto mb-5 size-14 rounded-2xl shadow-lg shadow-[#ff2d7e]/30" />
          <div className="mx-auto mb-4 flex w-fit items-center gap-2 rounded-full border border-[#ff2d7e]/25 bg-[#ff2d7e]/10 px-3 py-1 text-xs font-semibold text-[#ff6ca4]">
            <RefreshCw className="size-3.5 animate-spin" />
            必须更新
          </div>
          <h1 id="required-update-title" className="text-xl font-semibold text-white">
            请更新小音符起号助手
          </h1>
          <p
            id="required-update-description"
            className="mt-3 text-sm leading-6 text-white/60"
          >
            新版本已经就绪，包含片尾替换与恢复内置功能。更新完成前，当前桌面版将暂停使用。
          </p>
          <div className="mt-6 rounded-xl border border-white/8 bg-black/20 px-4 py-3 text-left text-xs leading-5 text-white/50">
            更新会在后台自动下载。看到系统提示后点击“立即重启更新”；若暂未出现，请按 ⌘Q
            完全退出应用并重新打开。
          </div>
        </div>
      </div>
    </dialog>
  );
}
