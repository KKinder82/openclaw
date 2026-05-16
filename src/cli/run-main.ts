import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isTruthyEnvValue, normalizeEnv } from "../infra/env.js";
import { isMainModule } from "../infra/is-main.js";
import type { ProxyHandle } from "../infra/net/proxy/proxy-lifecycle.js";
import { ensureOpenClawCliOnPath } from "../infra/path-env.js";
import { assertSupportedRuntime } from "../infra/runtime-guard.js";
import type { PluginManifestCommandAliasRegistry } from "../plugins/manifest-command-aliases.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { resolveCliArgvInvocation } from "./argv-invocation.js";
import {
  shouldRegisterPrimaryCommandOnly,
  shouldSkipPluginCommandRegistration,
} from "./command-registration-policy.js";
import { maybeRunCliInContainer, parseCliContainerArgs } from "./container-target.js";
import {
  consumeGatewayFastPathRootOptionToken,
  consumeGatewayRunOptionToken,
} from "./gateway-run-argv.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "./profile.js";
import {
  resolveMissingPluginCommandMessage as resolveMissingPluginCommandMessageFromPolicy,
  rewriteUpdateFlagArgv,
  shouldEnsureCliPath,
  shouldStartCrestodianForBareRoot,
  shouldStartCrestodianForModernOnboard,
  shouldStartProxyForCli,
  shouldUseBrowserHelpFastPath,
  shouldUseRootHelpFastPath,
} from "./run-main-policy.js";
import { normalizeWindowsArgv } from "./windows-argv.js";

export {
  rewriteUpdateFlagArgv,
  shouldEnsureCliPath,
  shouldStartCrestodianForBareRoot,
  shouldStartCrestodianForModernOnboard,
  shouldStartProxyForCli,
  shouldUseBrowserHelpFastPath,
  shouldUseRootHelpFastPath,
} from "./run-main-policy.js";

type Awaitable<T> = T | Promise<T>;

const CLI_PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
] as const;

// 创建GatewayCli启动跟踪。
function createGatewayCliMainStartupTrace(argv: string[]) {
  const enabled =
    isTruthyEnvValue(process.env.OPENCLAW_GATEWAY_STARTUP_TRACE) &&
    argv.slice(2).includes("gateway");
  const started = performance.now();
  let last = started;
  const emit = (name: string, durationMs: number, totalMs: number) => {
    if (!enabled) {
      return;
    }
    process.stderr.write(
      `[gateway] startup trace: cli.main.${name} ${durationMs.toFixed(1)}ms total=${totalMs.toFixed(1)}ms\n`,
    );
  };
  return {
    mark(name: string) {
      const now = performance.now();
      emit(name, now - last, now - started);
      last = now;
    },
    async measure<T>(name: string, run: () => Awaitable<T>): Promise<T> {
      const before = performance.now();
      try {
        return await run();
      } finally {
        const now = performance.now();
        emit(name, now - before, now - started);
        last = now;
      }
    },
  };
}

// 判断是否符合 Gateway Run 快速路径的命令行参数要求，
// 依据是命令行参数是否符合 Gateway Run 快速路径的要求。
export function isGatewayRunFastPathArgv(argv: string[]): boolean {
  const invocation = resolveCliArgvInvocation(argv);
  if (invocation.hasHelpOrVersion) {
    return false;
  }
  const args = argv.slice(2);
  let sawGateway = false;
  let sawRun = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg || arg === "--") {
      return false;
    }
    if (!sawGateway) {
      const consumed = consumeGatewayFastPathRootOptionToken(args, index);
      if (consumed > 0) {
        // 参数
        index += consumed - 1;
        continue;
      }
      if (arg !== "gateway") {
        // 命令不是 gateway，返回 false。
        return false;
      }
      // 命令是 gateway，继续检查后续参数。
      sawGateway = true;
      continue;
    }

    const consumed = consumeGatewayRunOptionToken(args, index);
    if (consumed > 0) {
      index += consumed - 1;
      continue;
    }
    if (!sawRun && arg === "run") {
      sawRun = true;
      continue;
    }
    return false;
  }

  // 仅返回 gateway 或 gateway run 命令时，才符合快速路径要求。
  return sawGateway;
}

function hasJsonOutputFlag(argv: string[]): boolean {
  return argv.some((arg) => arg === "--json" || arg.startsWith("--json="));
}

// 尝试运行 Gateway Run 快速路径，
// 依据是命令行参数是否符合 Gateway Run 快速路径的要求。
async function tryRunGatewayRunFastPath(
  argv: string[],
  startupTrace: ReturnType<typeof createGatewayCliMainStartupTrace>,
): Promise<boolean> {
  if (!isGatewayRunFastPathArgv(argv)) {
    // 命令行参数不符合 Gateway Run 快速路径的要求，返回 false。
    return false;
  }

  // 导入 Gateway Run 相关的模块，准备运行 Gateway Run 快速路径。
  const [
    { Command },
    { addGatewayRunCommand },
    { VERSION },
    { emitCliBanner },
    { resolveCliStartupPolicy },
  ] = await startupTrace.measure("gateway-run-imports", () =>
    Promise.all([
      import("commander"),
      import("./gateway-cli/run.js"), // Gateway Run 相关的命令实现。
      import("../version.js"),
      import("./banner.js"),
      import("./command-startup-policy.js"),
    ]),
  );
  const invocation = resolveCliArgvInvocation(argv);
  const startupPolicy = resolveCliStartupPolicy({
    commandPath: invocation.commandPath,
    jsonOutputMode: hasJsonOutputFlag(argv),
    routeMode: true,
  });
  if (!startupPolicy.hideBanner) {
    // 输出 CLI 横幅，包含版本信息和其他相关信息，提供用户反馈，指示正在启动 Gateway Run。
    emitCliBanner(VERSION, { argv });
  }
  const program = new Command();
  program.name("openclaw"); // 命令
  program.enablePositionalOptions();
  program.option("--no-color", "Disable ANSI colors", false);
  program.exitOverride((err) => {
    process.exitCode = typeof err.exitCode === "number" ? err.exitCode : 1;
    throw err;
  });
  const gateway = addGatewayRunCommand(
    program.command("gateway").description("Run, inspect, and query the WebSocket Gateway"),
  );

  addGatewayRunCommand(
    gateway.command("run").description("Run the WebSocket Gateway (foreground)"),
  );
  try {
    await startupTrace.measure("gateway-run-parse", () => program.parseAsync(argv));
  } catch (error) {
    if (!isCommanderParseExit(error)) {
      throw error;
    }
    process.exitCode = error.exitCode;
  }
  return true;
}

async function closeCliMemoryManagers(): Promise<void> {
  try {
    const { hasMemoryRuntime } = await import("../plugins/memory-state.js");
    if (!hasMemoryRuntime()) {
      return;
    }
    const { closeActiveMemorySearchManagers } = await import("../plugins/memory-runtime.js");
    await closeActiveMemorySearchManagers();
  } catch {
    // Best-effort teardown for short-lived CLI processes. Package updates can
    // replace hashed chunks before this finalizer runs.
  }
}

export function resolveMissingPluginCommandMessage(
  pluginId: string,
  config?: OpenClawConfig,
  options?: { registry?: PluginManifestCommandAliasRegistry },
): string | null {
  return resolveMissingPluginCommandMessageFromPolicy(
    pluginId,
    config,
    options?.registry ? { registry: options.registry } : undefined,
  );
}

// 是否需要加载 CLI 的 .env 文件，判断依据是当前工作目录或者 stateDir 中是否存在 .env 文件。
function shouldLoadCliDotEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  if (existsSync(path.join(process.cwd(), ".env"))) {
    // 如果当前工作目录下存在 .env 文件，则需要加载 CLI 的 .env 文件。
    return true;
  }
  return existsSync(path.join(resolveStateDir(env), ".env"));
}

function isCommanderParseExit(error: unknown): error is { exitCode: number } {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as { code?: unknown; exitCode?: unknown };
  return (
    typeof candidate.exitCode === "number" &&
    Number.isInteger(candidate.exitCode) &&
    typeof candidate.code === "string" &&
    candidate.code.startsWith("commander.")
  );
}

async function ensureCliEnvProxyDispatcher(): Promise<void> {
  try {
    const { hasEnvHttpProxyAgentConfigured } = await import("../infra/net/proxy-env.js");
    if (!hasEnvHttpProxyAgentConfigured()) {
      // 如果环境变量中没有配置 HTTP 代理相关的设置，则不需要启动 CLI 环境的全局代理调度器，直接返回。
      return;
    }
    // 启动 CLI 环境的全局代理调度器，确保在需要代理的网络请求中正确地使用代理设置。
    const { ensureGlobalUndiciEnvProxyDispatcher } =
      await import("../infra/net/undici-global-dispatcher.js");
    ensureGlobalUndiciEnvProxyDispatcher();
  } catch {
    // Best-effort proxy bootstrap; CLI startup should continue without it.
  }
}

// 判断是否应该在尝试 Gateway Run 快速路径之前引导 CLI 代理捕获和调度器，依据是环境变量设置，
function shouldBootstrapCliProxyBeforeFastPath(env: NodeJS.ProcessEnv = process.env): boolean {
  if (
    isTruthyEnvValue(env.OPENCLAW_DEBUG_PROXY_ENABLED) ||
    isTruthyEnvValue(env.OPENCLAW_DEBUG_PROXY_REQUIRE)
  ) {
    // 如果调试代理被显式启用或者要求启用，则应该在尝试 Gateway Run 快速路径之前引导 CLI 代理捕获和调度器，以确保调试代理能够正确地捕获和处理网络请求。
    return true;
  }
  // 如果有一个环境变量时，返回 true，
  // 表示应该在尝试 Gateway Run 快速路径之前引导 CLI 代理捕获和调度器，以确保调试代理能够正确地捕获和处理网络请求。
  return CLI_PROXY_ENV_KEYS.some((key) => {
    const value = env[key];
    return typeof value === "string" && value.trim().length > 0;
  });
}

async function bootstrapCliProxyCaptureAndDispatcher(
  startupTrace: ReturnType<typeof createGatewayCliMainStartupTrace>,
): Promise<void> {
  const [
    { initializeDebugProxyCapture, finalizeDebugProxyCapture },
    { maybeWarnAboutDebugProxyCoverage },
  ] = await startupTrace.measure("proxy-imports", () =>
    Promise.all([import("../proxy-capture/runtime.js"), import("../proxy-capture/coverage.js")]),
  );
  initializeDebugProxyCapture("cli");
  process.once("exit", () => {
    finalizeDebugProxyCapture();
  });
  await startupTrace.measure("proxy-dispatcher", () => ensureCliEnvProxyDispatcher());
  maybeWarnAboutDebugProxyCoverage();
}

// 程序入口
// argv: 传入的命令行参数数组，默认为 process.argv。
export async function runCli(argv: string[] = process.argv) {
  const originalArgv = normalizeWindowsArgv(argv);
  const startupTrace = createGatewayCliMainStartupTrace(originalArgv);
  // 分析命令行是否有容器目标参数，如果有则设置环境变量以指示后续流程当前在容器环境中运行。
  const parsedContainer = parseCliContainerArgs(originalArgv);
  if (!parsedContainer.ok) {
    // 如果分析错误。
    // Container 可以有，也可以没有。
    throw new Error(parsedContainer.error);
  }
  // parsedContainer.argv 己经是去掉了容器相关参数的剩余参数了。
  const parsedProfile = parseCliProfileArgs(parsedContainer.argv);
  if (!parsedProfile.ok) {
    throw new Error(parsedProfile.error);
  }
  if (parsedProfile.profile) {
    // 如果有 profile 参数，则设置相关环境变量以指示当前的 profile。
    applyCliProfileEnv({ profile: parsedProfile.profile });
  }
  const containerTargetName =
    parsedContainer.container ?? normalizeOptionalString(process.env.OPENCLAW_CONTAINER) ?? null;
  if (containerTargetName && parsedProfile.profile) {
    throw new Error("--container cannot be combined with --profile/--dev");
  }

  // 如果是在 容器中运行
  const containerTarget = maybeRunCliInContainer(originalArgv);
  if (containerTarget.handled) {
    // 如果命令在容器中被处理了（即当前是在容器环境中运行，并且命令已经在容器中执行了），
    if (containerTarget.exitCode !== 0) {
      process.exitCode = containerTarget.exitCode;
    }
    return;
  }

  // 继续正常的 CLI 启动流程。
  let normalizedArgv = parsedProfile.argv;
  startupTrace.mark("argv");

  if (shouldLoadCliDotEnv()) {
    // 需要加载
    await startupTrace.measure("dotenv", async () => {
      const { loadCliDotEnv } = await import("./dotenv.js");
      loadCliDotEnv({ quiet: true });
    });
  }

  // 标准化环境变量
  normalizeEnv();
  // 应该保证 CLI 可执行文件在 PATH 中，以便子进程调用，
  // 依据是当前命令路径的策略配置和是否是某些特殊调用（如根帮助调用）。
  if (shouldEnsureCliPath(normalizedArgv)) {
    // 确保 CLI 可执行文件在 PATH 中
    ensureOpenClawCliOnPath();
  }

  // Enforce the minimum supported runtime before doing any work.
  assertSupportedRuntime();

  // Activate operator-managed proxy routing for network-capable commands.
  // Local Gateway/control-plane commands keep direct loopback access while
  // runtime, provider, plugin, update, and unknown plugin commands route egress.
  // 代理路由的启动和管理，
  // 依据是当前命令路径的策略配置和环境变量设置。
  // 【句柄】代理句柄
  let proxyHandle: ProxyHandle | null = null;
  // 停止已经启动的代理，确保在 CLI 进程退出前清理资源，避免孤儿进程和端口占用。
  // 【函数】停止已经启动的代理
  const stopStartedProxy = async () => {
    const handle = proxyHandle;
    proxyHandle = null;
    if (handle) {
      const { stopProxy } = await import("../infra/net/proxy/proxy-lifecycle.js");
      await stopProxy(handle);
    }
  };
  //【函数】 清理已经启动的代理
  const killStartedProxy = () => {
    const handle = proxyHandle;
    proxyHandle = null;
    handle?.kill("SIGTERM");
  };

  if (shouldStartProxyForCli(normalizedArgv)) {
    // 导入代理相关的模块，准备启动 CLI 代理，
    const [{ readBestEffortConfig }, { startProxy }] = await Promise.all([
      import("../config/io.js"),
      import("../infra/net/proxy/proxy-lifecycle.js"),
    ]);
    // 读取配置并启动代理，
    // 确保在 CLI 进程退出前清理资源，避免孤儿进程和端口占用。
    const config = await readBestEffortConfig();
    // 启动代理，依据是当前命令路径的策略配置和环境变量设置。
    proxyHandle = await startProxy(config?.proxy ?? undefined);
  }

  let onSigterm: (() => void) | null = null; // 终止信号，用于在接收到 SIGTERM 信号时优雅地关闭代理和退出进程。
  let onSigint: (() => void) | null = null; // 中断信号，用于在接收到 SIGINT 信号时优雅地关闭代理和退出进程。
  let onExit: (() => void) | null = null; // 退出事件，用于在进程退出时清理代理资源，确保没有孤儿进程和端口占用。
  if (proxyHandle) {
    const shutdown = (exitCode: number) => {
      if (onSigterm) {
        // 移除信号监听器，防止重复调用 shutdown。
        process.off("SIGTERM", onSigterm);
      }
      if (onSigint) {
        // 移除信号监听器，防止重复调用 shutdown。
        process.off("SIGINT", onSigint);
      }
      void stopStartedProxy().finally(() => {
        process.exit(exitCode);
      });
    };
    onSigterm = () => shutdown(143);
    onSigint = () => shutdown(130);
    onExit = () => killStartedProxy();

    // 监听终止和中断信号，
    // 当前进程接收到 SIGTERM 或 SIGINT 信号时，
    // 优雅地关闭代理并退出进程，确保没有孤儿进程和端口占用。
    process.once("SIGTERM", onSigterm);
    process.once("SIGINT", onSigint);
    process.once("exit", onExit);
  }

  try {
    // 帮助文本，
    if (shouldUseRootHelpFastPath(normalizedArgv)) {
      const { outputPrecomputedRootHelpText } = await import("./root-help-metadata.js");
      if (!outputPrecomputedRootHelpText()) {
        const { outputRootHelp } = await import("./program/root-help.js");
        await outputRootHelp();
      }
      return;
    }

    // 浏览器帮助文本，
    if (shouldUseBrowserHelpFastPath(normalizedArgv)) {
      const { outputPrecomputedBrowserHelpText } = await import("./root-help-metadata.js");
      if (outputPrecomputedBrowserHelpText()) {
        return;
      }
    }

    const shouldRunBareRootCrestodian = shouldStartCrestodianForBareRoot(normalizedArgv);
    const shouldRunModernOnboardCrestodian = shouldStartCrestodianForModernOnboard(normalizedArgv);
    if (shouldRunBareRootCrestodian || shouldRunModernOnboardCrestodian) {
      // 启动 Crestodian，Crestodian 是 OpenClaw 的一个组件，提供了系统状态监控和管理功能。
      await ensureCliEnvProxyDispatcher();
    }

    if (shouldRunBareRootCrestodian) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        // Crestodian 需要一个交互式 TTY 来运行。如果没有提供 TTY，输出错误信息并退出。
        console.error(
          'Crestodian needs an interactive TTY. Use `openclaw crestodian --message "status"` for one command.',
        );
        process.exitCode = 1;
        return;
      }
      const { runCrestodian } = await import("../crestodian/crestodian.js");
      const { createCliProgress } = await import("./progress.js");
      // 启动 Crestodian 的进度显示，提供用户反馈，指示正在启动 Crestodian。
      const progress = createCliProgress({
        label: "Starting Crestodian…",
        indeterminate: true,
        delayMs: 0,
        fallback: "none",
      });
      let progressStopped = false;
      const stopProgress = () => {
        if (progressStopped) {
          return;
        }
        progressStopped = true;
        progress.done();
      };
      try {
        // 启动好后，stopProgress 会被 onReady 调用，以停止进度显示。
        await runCrestodian({ onReady: stopProgress });
      } finally {
        stopProgress();
      }
      return; // 完成
    }

    if (shouldRunModernOnboardCrestodian) {
      // 启动 Modern Onboard 的 Crestodian，
      // Modern Onboard 是 OpenClaw 的一个子系统，提供了现代化的用户引导和交互功能。
      const { runCrestodian } = await import("../crestodian/crestodian.js");
      // 现代化引导的 Crestodian 需要一个交互式 TTY 来运行。如果没有提供 TTY，输出错误信息并退出。
      const nonInteractive = normalizedArgv.includes("--non-interactive");
      await runCrestodian({
        message: nonInteractive ? "overview" : undefined,
        yes: false,
        json: normalizedArgv.includes("--json"), // 如果命令行参数中包含 --json，则以 JSON 格式输出 Crestodian 的结果。
        interactive: !nonInteractive,
      });
      return; // 完成
    }

    const bootstrapProxyBeforeFastPath = shouldBootstrapCliProxyBeforeFastPath();
    if (
      !bootstrapProxyBeforeFastPath && // 如果不需要在尝试 Gateway Run 快速路径之前引导 CLI 代理捕获和调度器，
      (await tryRunGatewayRunFastPath(normalizedArgv, startupTrace))
    ) {
      return;
    }

    await bootstrapCliProxyCaptureAndDispatcher(startupTrace);

    if (
      bootstrapProxyBeforeFastPath &&
      (await tryRunGatewayRunFastPath(normalizedArgv, startupTrace))
    ) {
      return;
    }

    const { tryRouteCli } = await startupTrace.measure("route-import", () => import("./route.js"));
    if (await startupTrace.measure("route", () => tryRouteCli(normalizedArgv))) {
      return;
    }

    const { createCliProgress } = await import("./progress.js");
    const startupProgress = createCliProgress({
      label: "Loading OpenClaw CLI…",
      indeterminate: true,
      delayMs: 0,
      fallback: "none",
    });
    let startupProgressStopped = false;
    const stopStartupProgress = () => {
      if (startupProgressStopped) {
        return;
      }
      startupProgressStopped = true;
      startupProgress.done();
    };

    try {
      // Capture all console output into structured logs while keeping stdout/stderr behavior.
      const { enableConsoleCapture } = await import("../logging.js");
      enableConsoleCapture();

      const [
        { buildProgram },
        { formatUncaughtError },
        { runFatalErrorHooks },
        {
          installUnhandledRejectionHandler,
          isBenignUncaughtExceptionError,
          isUncaughtExceptionHandled,
        },
        { restoreTerminalState },
      ] = await startupTrace.measure("core-imports", () =>
        Promise.all([
          import("./program.js"),
          import("../infra/errors.js"),
          import("../infra/fatal-error-hooks.js"),
          import("../infra/unhandled-rejections.js"),
          import("../terminal/restore.js"),
        ]),
      );
      const program = await startupTrace.measure("build-program", () => buildProgram());

      // Global error handlers to prevent silent crashes from unhandled rejections/exceptions.
      // These log the error and exit gracefully instead of crashing without trace.
      installUnhandledRejectionHandler();

      process.on("uncaughtException", (error) => {
        if (isUncaughtExceptionHandled(error)) {
          return;
        }
        if (isBenignUncaughtExceptionError(error)) {
          console.warn(
            "[openclaw] Non-fatal uncaught exception (continuing):",
            formatUncaughtError(error),
          );
          return;
        }
        console.error("[openclaw] Uncaught exception:", formatUncaughtError(error));
        for (const message of runFatalErrorHooks({ reason: "uncaught_exception", error })) {
          console.error("[openclaw]", message);
        }
        restoreTerminalState("uncaught exception", { resumeStdinIfPaused: false });
        process.exit(1);
      });

      const parseArgv = rewriteUpdateFlagArgv(normalizedArgv);
      const invocation = resolveCliArgvInvocation(parseArgv);
      // Register the primary command (builtin or subcli) so help and command parsing
      // are correct even with lazy command registration.
      const { primary } = invocation;
      if (primary && shouldRegisterPrimaryCommandOnly(parseArgv)) {
        await startupTrace.measure("register-primary", async () => {
          const { getProgramContext } = await import("./program/program-context.js");
          const ctx = getProgramContext(program);
          if (ctx) {
            const { registerCoreCliByName } = await import("./program/command-registry.js");
            await registerCoreCliByName(program, ctx, primary, parseArgv);
          }
          const { registerSubCliByName } = await import("./program/register.subclis.js");
          await registerSubCliByName(program, primary, parseArgv);
        });
      }

      const hasBuiltinPrimary =
        primary !== null &&
        program.commands.some(
          (command) => command.name() === primary || command.aliases().includes(primary),
        );
      const shouldSkipPluginRegistration = shouldSkipPluginCommandRegistration({
        argv: parseArgv,
        primary,
        hasBuiltinPrimary,
      });
      if (!shouldSkipPluginRegistration) {
        const config = await startupTrace.measure("register-plugin-commands", async () => {
          const { registerPluginCliCommandsFromValidatedConfig } =
            await import("../plugins/cli.js");
          return await registerPluginCliCommandsFromValidatedConfig(program, undefined, undefined, {
            mode: "lazy",
            primary,
          });
        });
        if (config) {
          if (
            primary &&
            !program.commands.some(
              (command) => command.name() === primary || command.aliases().includes(primary),
            )
          ) {
            const { resolveManifestCommandAliasOwner } =
              await import("../plugins/manifest-command-aliases.runtime.js");
            const missingPluginCommandMessage = resolveMissingPluginCommandMessageFromPolicy(
              primary,
              config,
              {
                resolveCommandAliasOwner: resolveManifestCommandAliasOwner,
              },
            );
            if (missingPluginCommandMessage) {
              throw new Error(missingPluginCommandMessage);
            }
          }
        }
      }

      stopStartupProgress();

      try {
        await startupTrace.measure("parse", () => program.parseAsync(parseArgv));
      } catch (error) {
        if (!isCommanderParseExit(error)) {
          throw error;
        }
        process.exitCode = error.exitCode;
      }
    } finally {
      stopStartupProgress();
    }
  } finally {
    if (onSigterm) {
      process.off("SIGTERM", onSigterm);
    }
    if (onSigint) {
      process.off("SIGINT", onSigint);
    }
    if (onExit) {
      process.off("exit", onExit);
    }
    await stopStartedProxy();
    await closeCliMemoryManagers();
  }
}

export function isCliMainModule(): boolean {
  return isMainModule({ currentFile: fileURLToPath(import.meta.url) });
}
