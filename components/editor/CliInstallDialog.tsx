"use client";

import { useRef, useState } from "react";
import {
  Check,
  CircleAlert,
  Copy,
  Loader2,
  RotateCw,
  Terminal,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { DesktopCliInstallState } from "@/lib/desktop-bridge";
import { cn } from "@/lib/utils";

const START_COMMAND = "littlestart init video.json --minimal";
const VERIFY_COMMAND = "littlestart version --json";
const PATH_COMMAND = 'export PATH="$HOME/.local/bin:$PATH"';

function statusPresentation(state: DesktopCliInstallState | null, loading: boolean) {
  if (loading) {
    return { label: "正在检查", dot: "bg-sky-400", tone: "text-sky-300" };
  }
  if (state?.status === "installed" && state.pathConfigured === false) {
    return { label: "PATH 待配置", dot: "bg-amber-400", tone: "text-amber-300" };
  }
  switch (state?.status) {
    case "installed":
      return { label: "已安装", dot: "bg-emerald-400", tone: "text-emerald-300" };
    case "installing":
      return { label: "安装中", dot: "bg-sky-400", tone: "text-sky-300" };
    case "repair-needed":
      return { label: "需要修复", dot: "bg-amber-400", tone: "text-amber-300" };
    case "conflict":
      return { label: "命令冲突", dot: "bg-amber-400", tone: "text-amber-300" };
    case "error":
      return { label: "暂不可用", dot: "bg-red-400", tone: "text-red-300" };
    case "unsupported":
      return { label: "当前版本不支持", dot: "bg-zinc-500", tone: "text-zinc-400" };
    default:
      return { label: "尚未安装", dot: "bg-zinc-500", tone: "text-zinc-300" };
  }
}

async function copyText(value: string, success: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(success);
  } catch {
    toast.error("复制失败，请手动复制");
  }
}

export function CliInstallDialog() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [state, setState] = useState<DesktopCliInstallState | null>(null);
  const requestRef = useRef(0);

  const loadState = async () => {
    const request = ++requestRef.current;
    setLoading(true);
    try {
      const bridge = window.electronRender;
      if (!bridge?.supportsCliInstall || !bridge.getCliInstallState) {
        throw new Error("当前桌面版不支持 CLI 安装");
      }
      const next = await bridge.getCliInstallState();
      if (request === requestRef.current) setState(next);
    } catch {
      if (request === requestRef.current) {
        setState({
          status: "error",
          errorCode: "CLI_RUNTIME_MISSING",
          message: "无法读取 CLI 状态，请重启或更新桌面版后重试。",
          retryable: true,
        });
      }
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  };

  const install = async () => {
    const bridge = window.electronRender;
    if (!bridge?.installCli) return;
    setInstalling(true);
    setState((current) => ({
      ...(current ?? { status: "installing" as const }),
      status: "installing",
      message: "正在写入启动器并验证运行环境…",
    }));
    try {
      const result = await bridge.installCli();
      setState(result.state);
      if (result.ok && result.state.pathConfigured === false) {
        toast.warning("CLI 已安装，还需要手动配置 PATH");
      } else if (result.ok) toast.success("Littlestart CLI 已安装");
      else if (!result.canceled) toast.error(result.error);
    } catch {
      setState({
        status: "error",
        errorCode: "VERIFY_FAILED",
        message: "安装请求没有完成，请重试。",
        retryable: true,
      });
      toast.error("CLI 安装没有完成");
    } finally {
      setInstalling(false);
    }
  };

  const status = statusPresentation(state, loading);
  const isInstalled = state?.status === "installed";
  const isReady = isInstalled && state.pathConfigured !== false;
  const needsManualPath = isInstalled && state.pathConfigured === false;
  const canInstall =
    !loading &&
    !installing &&
    (state?.status === "not-installed" ||
      state?.status === "repair-needed" ||
      (state?.status === "error" && state.retryable === true));
  const installLabel = state?.status === "repair-needed" ? "修复安装" : "安装 CLI";
  const canRecheck =
    !loading &&
    !installing &&
    (state?.status === "conflict" ||
      state?.status === "error" ||
      state?.status === "unsupported" ||
      needsManualPath);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) void loadState();
        else requestRef.current += 1;
      }}
    >
      <DialogTrigger
        render={<Button variant="ghost" size="sm" title="安装命令行工具" />}
      >
        <Terminal className="size-4" /> CLI
      </DialogTrigger>

        <DialogContent className="overflow-hidden border-white/10 bg-[#111117] p-0 shadow-2xl shadow-black/60 sm:max-w-[460px]">
          <div className="border-b border-white/8 bg-[#15151c] px-5 py-4">
            <DialogHeader className="pr-8">
              <div className="flex items-center gap-3">
                <div className="flex size-9 items-center justify-center rounded-lg border border-[#ff2d7e]/25 bg-[#ff2d7e]/10 text-[#ff5b97]">
                  <Terminal className="size-4.5" />
                </div>
                <div className="space-y-1">
                  <DialogTitle>命令行与自动化</DialogTitle>
                  <DialogDescription className="text-xs">
                    在 Codex、Claude Code 或终端中生产视频
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>
          </div>

          <div className="space-y-4 px-5 py-5">
            <div className="overflow-hidden rounded-xl border border-white/8 bg-[#09090d]">
              <div className="flex h-8 items-center gap-1.5 border-b border-white/6 px-3">
                <span className="size-2 rounded-full bg-[#ff5f57]/70" />
                <span className="size-2 rounded-full bg-[#febc2e]/70" />
                <span className="size-2 rounded-full bg-[#28c840]/70" />
                <span className="ml-2 text-[10px] tracking-wide text-zinc-600">LITTLESTART CLI</span>
              </div>
              <div className="space-y-2 px-4 py-3 font-mono text-[12px] leading-relaxed">
                <p className="text-zinc-300">
                  <span className="mr-2 text-[#ff5b97]">$</span>
                  {needsManualPath ? PATH_COMMAND : isReady ? VERIFY_COMMAND : START_COMMAND}
                </p>
                <p className="text-zinc-600">
                  {needsManualPath
                    ? "# 添加到 shell 配置后新开终端"
                    : isReady
                      ? `littlestart ${state.installedVersion ?? "ready"}`
                      : "# GUI 无需打开"}
                </p>
              </div>
            </div>

            <div aria-live="polite" className="rounded-lg border border-white/8 bg-white/[0.025] p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  {loading || installing ? (
                    <Loader2 className="size-3.5 shrink-0 animate-spin text-sky-300" />
                  ) : (
                    <span className={cn("size-2 shrink-0 rounded-full", status.dot)} />
                  )}
                  <span className={cn("text-xs font-medium", status.tone)}>{status.label}</span>
                </div>
                {state?.bundledVersion ? (
                  <span className="font-mono text-[10px] text-zinc-500">v{state.bundledVersion}</span>
                ) : null}
              </div>

              <p className="mt-2 text-[12px] leading-relaxed text-zinc-400">
                {loading ? "正在读取本机安装状态…" : state?.message ?? "准备检查 CLI。"}
              </p>

              {state?.installPath ? (
                <div className="mt-2 flex items-center gap-2 text-[11px] text-zinc-500">
                  <span className="shrink-0">位置</span>
                  <code className="truncate">{state.installPath}</code>
                </div>
              ) : null}
            </div>

            {state?.status === "conflict" || state?.errorCode === "APP_NOT_STABLE" ? (
              <div className="flex gap-2 rounded-lg border border-amber-400/15 bg-amber-400/[0.06] p-3 text-[11px] leading-relaxed text-amber-100/70">
                <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-300" />
                <span>
                  {state.status === "conflict"
                    ? "为保护你已有的命令，安装器不会自动覆盖。请先移动或删除该文件，再点击“重新检查”。"
                    : "从安装镜像直接运行时，退出后命令会失效。请先把 App 拖到“应用程序”。"}
                </span>
              </div>
            ) : null}

            <div className="flex items-center gap-2">
              {canInstall ? (
                <Button
                  onClick={() => void install()}
                  disabled={installing}
                  className="flex-1 bg-[#ff2d7e] text-white hover:bg-[#ff2d7e]/90"
                >
                  {installing ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : state?.status === "repair-needed" || isInstalled ? (
                    <RotateCw className="size-4" />
                  ) : (
                    <Terminal className="size-4" />
                  )}
                  {installing ? "安装并自检中…" : installLabel}
                </Button>
              ) : null}

              {isReady ? (
                <Button
                  variant={canInstall ? "outline" : "default"}
                  className={cn(!canInstall && "flex-1 bg-emerald-500 text-black hover:bg-emerald-400")}
                  onClick={() => void copyText(START_COMMAND, "开始命令已复制")}
                >
                  {canInstall ? <Copy className="size-4" /> : <Check className="size-4" />}
                  复制开始命令
                </Button>
              ) : null}

              {needsManualPath ? (
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={() => void copyText(PATH_COMMAND, "PATH 配置已复制")}
                >
                  <Copy className="size-4" /> 复制 PATH 配置
                </Button>
              ) : null}

              {canRecheck ? (
                <Button variant="outline" onClick={() => void loadState()}>
                  <RotateCw className={cn("size-4", loading && "animate-spin")} /> 重新检查
                </Button>
              ) : null}
            </div>

            {isReady ? (
              <button
                type="button"
                className="mx-auto flex items-center gap-1.5 text-[11px] text-zinc-500 transition-colors hover:text-zinc-300"
                onClick={() => void copyText(VERIFY_COMMAND, "验证命令已复制")}
              >
                <Copy className="size-3" /> 复制验证命令
              </button>
            ) : null}

            <p className="text-center text-[11px] leading-relaxed text-zinc-500">
              离线安装，不需要 Node.js、npm、网络或管理员权限。安装后请新开一个终端窗口。
            </p>
          </div>
        </DialogContent>
    </Dialog>
  );
}
