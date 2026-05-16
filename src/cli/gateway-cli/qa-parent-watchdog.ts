import { createSubsystemLogger } from "../../logging/subsystem.js";

export const QA_PARENT_PID_ENV = "OPENCLAW_QA_PARENT_PID";

const DEFAULT_QA_PARENT_WATCHDOG_INTERVAL_MS = 1000;

type QaParentWatchdogTimer =
  | number
  | {
      unref?: () => unknown;
    };

type QaParentWatchdogDeps = {
  clearInterval?: (timer: QaParentWatchdogTimer) => void;
  env?: NodeJS.ProcessEnv;
  exit?: (code?: number) => never | void;
  intervalMs?: number;
  kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
  logger?: Pick<ReturnType<typeof createSubsystemLogger>, "warn">;
  ownPid?: number;
  setInterval?: (callback: () => void, ms: number) => QaParentWatchdogTimer;
};

export type QaParentWatchdogHandle = {
  parentPid: number;
  stop: () => void;
};

function resolveQaParentPid(env: NodeJS.ProcessEnv, ownPid: number): number | null {
  const raw = env[QA_PARENT_PID_ENV]?.trim();
  if (!raw) {
    // 环境变量未设置或为空，无法解析父进程 PID，返回 null。
    // 这种情况下，安装看门狗没有意义，因为无法确定要监视哪个父进程。
    return null;
  }
  const parentPid = Number(raw);
  if (!Number.isSafeInteger(parentPid) || parentPid <= 0 || parentPid === ownPid) {
    return null;
  }
  return parentPid;
}

// 安装一个看门狗定时器，定期检查指定的父进程是否仍然存在，
// 如果父进程退出了，则日志警告并退出当前进程，避免成为孤儿进程。
// 这个函数主要用于 QA 环境下的 Gateway CLI，确保当父进程（如测试运行器）退出时，Gateway CLI 不会继续孤立运行。
export function installQaParentWatchdog(
  deps: QaParentWatchdogDeps = {},
): QaParentWatchdogHandle | null {
  const env = deps.env ?? process.env;
  const ownPid = deps.ownPid ?? process.pid;
  const parentPid = resolveQaParentPid(env, ownPid);
  if (parentPid === null) {
    return null;
  }

  const clearIntervalFn =
    deps.clearInterval ??
    ((activeTimer: QaParentWatchdogTimer) => {
      clearInterval(activeTimer as ReturnType<typeof setInterval>);
    });
  const exit = deps.exit ?? ((code?: number) => process.exit(code));
  const kill =
    deps.kill ?? ((pid: number, signal?: NodeJS.Signals | 0) => process.kill(pid, signal));
  const logger = deps.logger ?? createSubsystemLogger("gateway");
  const setIntervalFn =
    deps.setInterval ??
    ((callback: () => void, ms: number) => setInterval(callback, ms) as QaParentWatchdogTimer);
  let stopped = false;
  let timer: QaParentWatchdogTimer;

  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    clearIntervalFn(timer);
  };

  timer = setIntervalFn(() => {
    if (stopped) {
      // 看门狗已经被停止，不再执行检查逻辑，直接返回。
      return;
    }
    try {
      // 通过发送信号 0 来检查父进程是否存在，如果父进程不存在或者无法访问，则会抛出一个错误。
      kill(parentPid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        logger.warn(`QA gateway parent pid ${parentPid} exited; shutting down orphaned QA gateway`);
        stop();
        exit(0);
      }
    }
  }, deps.intervalMs ?? DEFAULT_QA_PARENT_WATCHDOG_INTERVAL_MS);
  if (typeof timer === "object") {
    timer.unref?.();
  }

  return {
    parentPid,
    stop,
  };
}
