import * as net from "node:net";
import { Agent, EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { isWSL2Sync } from "../wsl.js";
import { hasEnvHttpProxyAgentConfigured, resolveEnvHttpProxyAgentOptions } from "./proxy-env.js";

export const DEFAULT_UNDICI_STREAM_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Module-level bridge so `resolveDispatcherTimeoutMs` in fetch-guard.ts
 * can read the global dispatcher timeout without relying on Undici's
 * non-public `.options` field.
 */
export let _globalUndiciStreamTimeoutMs: number | undefined;

const AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 300;

let lastAppliedTimeoutKey: string | null = null;
let lastAppliedProxyBootstrap = false;

type DispatcherKind = "agent" | "env-proxy" | "unsupported";

// 解析给定的调度器实例，
// 确定它是一个普通的 Agent、一个 EnvHttpProxyAgent，还是不受支持的类型。
// dispatcher 调试器实例，通常是通过 getGlobalDispatcher() 获取的全局 Undici 调度器。
function resolveDispatcherKind(dispatcher: unknown): DispatcherKind {
  // 构造函数名称是一个常见的方式来识别 Undici 调度器的类型，因为它们没有公开的类型标识。
  // dispatcher 是一个函数对象，且其构造函数具有一个可用的名称属性，且该名称是一个非空字符串。
  const ctorName = (dispatcher as { constructor?: { name?: string } })?.constructor?.name;
  if (typeof ctorName !== "string" || ctorName.length === 0) {
    return "unsupported";
  }
  if (ctorName.includes("EnvHttpProxyAgent")) {
    return "env-proxy";
  }
  if (ctorName.includes("ProxyAgent")) {
    return "unsupported";
  }
  if (ctorName.includes("Agent")) {
    return "agent";
  }
  return "unsupported";
}

// 获取当前全局 Undici 调度器的类型，
// 自动地址选择，是选择 IPv4 还是 IPv6，
// Undici 在 Node.js 18 中引入了 autoSelectFamily 选项，默认为 true，表示自动选择地址类型。
function resolveAutoSelectFamily(): boolean | undefined {
  if (typeof net.getDefaultAutoSelectFamily !== "function") {
    return undefined;
  }
  try {
    const systemDefault = net.getDefaultAutoSelectFamily();
    // WSL2 has unstable IPv6 connectivity; disable autoSelectFamily to
    // force IPv4 connections and avoid "fetch failed" errors when reaching
    // Windows-host services (e.g. Ollama) from inside WSL2.
    if (systemDefault && isWSL2Sync()) {
      return false;
    }
    return systemDefault;
  } catch {
    return undefined;
  }
}

function resolveConnectOptions(
  autoSelectFamily: boolean | undefined,
): { autoSelectFamily: boolean; autoSelectFamilyAttemptTimeout: number } | undefined {
  if (autoSelectFamily === undefined) {
    return undefined;
  }
  return {
    autoSelectFamily,
    autoSelectFamilyAttemptTimeout: AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS,
  };
}

function resolveDispatcherKey(params: {
  kind: DispatcherKind;
  timeoutMs: number;
  autoSelectFamily: boolean | undefined;
}): string {
  const autoSelectToken =
    params.autoSelectFamily === undefined ? "na" : params.autoSelectFamily ? "on" : "off";
  return `${params.kind}:${params.timeoutMs}:${autoSelectToken}`;
}

// 解析当前全局调度器的类型，
// 返回 "agent"、"env-proxy" 或 "unsupported"。
function resolveCurrentDispatcherKind(): DispatcherKind | null {
  let dispatcher: unknown;
  try {
    dispatcher = getGlobalDispatcher();
  } catch {
    return null;
  }

  const currentKind = resolveDispatcherKind(dispatcher);
  return currentKind === "unsupported" ? null : currentKind;
}

// 确保全局 Undici 调度器正确地反映当前的环境代理配置，必要时安装 EnvHttpProxyAgent。
export function ensureGlobalUndiciEnvProxyDispatcher(): void {
  const shouldUseEnvProxy = hasEnvHttpProxyAgentConfigured();
  if (!shouldUseEnvProxy) {
    // 没配置
    return;
  }
  // 有配置
  if (lastAppliedProxyBootstrap) {
    if (resolveCurrentDispatcherKind() === "env-proxy") {
      // 已经安装了 EnvHttpProxyAgent，并且当前全局调度器是 EnvHttpProxyAgent，无需更改。
      return;
    }
    // 上次引导安装了 EnvHttpProxyAgent，
    // 但当前全局调度器不是 EnvHttpProxyAgent，可能是被其他库覆盖了。
    // 为了避免频繁尝试安装，重置引导状态，让下一次调用时能够重新尝试安装。
    lastAppliedProxyBootstrap = false;
  }
  const currentKind = resolveCurrentDispatcherKind();
  if (currentKind === null) {
    // 没解析到有效的调度器类型，
    // 可能是 Undici 版本过旧或者全局调度器被其他库覆盖了，无法安全地安装 EnvHttpProxyAgent，因此直接返回，不做更改。
    return;
  }
  if (currentKind === "env-proxy") {
    lastAppliedProxyBootstrap = true;
    return;
  }
  // 当前全局调度器不是 EnvHttpProxyAgent，但环境变量中配置了 HTTP 代理相关的设置，尝试安装 EnvHttpProxyAgent。
  try {
    setGlobalDispatcher(new EnvHttpProxyAgent(resolveEnvHttpProxyAgentOptions()));
    lastAppliedProxyBootstrap = true;
  } catch {
    // Best-effort bootstrap only.
  }
}

// 确保全局 Undici 调度器的 stream 超时设置满足最低要求，必要时更新调度器实例以应用新的超时设置。
export function ensureGlobalUndiciStreamTimeouts(opts?: { timeoutMs?: number }): void {
  const timeoutMsRaw = opts?.timeoutMs ?? DEFAULT_UNDICI_STREAM_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMsRaw)) {
    return;
  }
  const timeoutMs = Math.max(DEFAULT_UNDICI_STREAM_TIMEOUT_MS, Math.floor(timeoutMsRaw));
  _globalUndiciStreamTimeoutMs = timeoutMs;
  const kind = resolveCurrentDispatcherKind();
  if (kind === null) {
    return;
  }

  const autoSelectFamily = resolveAutoSelectFamily();
  const nextKey = resolveDispatcherKey({ kind, timeoutMs, autoSelectFamily });
  if (lastAppliedTimeoutKey === nextKey) {
    return;
  }

  const connect = resolveConnectOptions(autoSelectFamily);
  try {
    if (kind === "env-proxy") {
      const proxyOptions = {
        ...resolveEnvHttpProxyAgentOptions(),
        bodyTimeout: timeoutMs,
        headersTimeout: timeoutMs,
        ...(connect ? { connect } : {}),
      } as ConstructorParameters<typeof EnvHttpProxyAgent>[0];
      setGlobalDispatcher(new EnvHttpProxyAgent(proxyOptions));
    } else {
      setGlobalDispatcher(
        new Agent({
          bodyTimeout: timeoutMs,
          headersTimeout: timeoutMs,
          ...(connect ? { connect } : {}),
        }),
      );
    }
    lastAppliedTimeoutKey = nextKey;
  } catch {
    // Best-effort hardening only.
  }
}

export function resetGlobalUndiciStreamTimeoutsForTests(): void {
  lastAppliedTimeoutKey = null;
  lastAppliedProxyBootstrap = false;
  _globalUndiciStreamTimeoutMs = undefined;
}

/**
 * Re-evaluate proxy env changes for undici. Installs EnvHttpProxyAgent when
 * proxy env is present, and restores a direct Agent after proxy env is cleared.
 */
export function forceResetGlobalDispatcher(): void {
  lastAppliedTimeoutKey = null;
  lastAppliedProxyBootstrap = false;
  try {
    const proxyOptions = resolveEnvHttpProxyAgentOptions();
    if (hasEnvHttpProxyAgentConfigured()) {
      setGlobalDispatcher(
        new EnvHttpProxyAgent(proxyOptions as ConstructorParameters<typeof EnvHttpProxyAgent>[0]),
      );
      lastAppliedProxyBootstrap = true;
    } else {
      setGlobalDispatcher(new Agent());
    }
  } catch {
    // Best-effort reset only.
  }
}
