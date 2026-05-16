import { spawnSync } from "node:child_process";
import { isIP } from "node:net";
import { consumeRootOptionToken, FLAG_TERMINATOR } from "../infra/cli-root-options.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { resolveCliArgvInvocation } from "./argv-invocation.js";
import { scanCliRootOptions } from "./root-option-scan.js";
import { takeCliRootOptionValue } from "./root-option-value.js";

type CliContainerParseResult =
  | { ok: true; container: string | null; argv: string[] }
  | { ok: false; error: string };

type CliContainerTargetResult =
  | { handled: true; exitCode: number }
  | { handled: false; argv: string[] };

type ContainerTargetDeps = {
  env: NodeJS.ProcessEnv;
  spawnSync: typeof spawnSync;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
};

type ContainerRuntimeExec = {
  runtime: "podman" | "docker";
  command: string;
  argsPrefix: string[];
};

const CONTAINER_ALLOW_LOOPBACK_PROXY_URL_ENV = "OPENCLAW_CONTAINER_ALLOW_LOOPBACK_PROXY_URL";

// 处理 CLI 容器目标，
// 如果 argv 中包含 --container 参数或者环境变量 OPENCLAW_CONTAINER 被设置，
export function parseCliContainerArgs(argv: string[]): CliContainerParseResult {
  let container: string | null = null;

  const scanned = scanCliRootOptions(argv, ({ arg, args, index }) => {
    if (arg === "--container" || arg.startsWith("--container=")) {
      const next = args[index + 1];
      // 获取选项值，支持两种格式：--container=value 或 --container value
      const { value, consumedNext } = takeCliRootOptionValue(arg, next);
      if (!value) {
        // 通知 scanCliRootOptions，出错
        return { kind: "error", error: "--container requires a value" };
      }
      // 容器名称
      container = value;
      //通知  scanCliRootOptions，成功处理了这个选项，告诉扫描器继续扫描剩余的参数。
      return { kind: "handled", consumedNext }; // { kind: "handled", consumedNext: consumedNext }
    }
    // 通知  scanCliRootOptions，没有处理，由 scanCliRootOptions处理。
    return { kind: "pass" };
  });

  if (!scanned.ok) {
    // 不成功，则返回
    return scanned;
  }
  // 重新包装再返回。
  // 相当于 return { ok: true, container: container, argv: scanned.argv };
  // 返回值有三部分：ok 表示解析成功，container 是解析到的容器名称（如果有的话），argv 是扫描处理后的剩余参数数组。
  return { ok: true, container, argv: scanned.argv };
}

// 解析 CLI 容器目标，优先级：
// 1. argv 中的 --container 参数
// 2. 环境变量 OPENCLAW_CONTAINER
// 如果都没有，则返回 null。
export function resolveCliContainerTarget(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const parsed = parseCliContainerArgs(argv);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  return parsed.container ?? normalizeOptionalString(env.OPENCLAW_CONTAINER) ?? null;
}

// 判断指定的容器是否正在运行, 通过执行类似 "docker inspect --format {{.State.Running}}" 的命令来检查容器状态。
function isContainerRunning(params: {
  exec: ContainerRuntimeExec;
  containerName: string;
  deps: Pick<ContainerTargetDeps, "spawnSync">;
}): boolean {
  const result = params.deps.spawnSync(
    params.exec.command,
    [...params.exec.argsPrefix, "inspect", "--format", "{{.State.Running}}", params.containerName],
    params.exec.command === "sudo"
      ? { encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] }
      : { encoding: "utf8" },
  );
  return result.status === 0 && result.stdout.trim() === "true";
}

function candidateContainerRuntimes(): ContainerRuntimeExec[] {
  return [
    {
      runtime: "podman",
      command: "podman",
      argsPrefix: [],
    },
    {
      runtime: "docker",
      command: "docker",
      argsPrefix: [],
    },
  ];
}

// 解析 当前是不是在 容器中运行
// 1. argv 中的 --container 参数
// 2. 环境变量 OPENCLAW_CONTAINER
// 如果都没有，则返回 null。
function resolveRunningContainer(params: {
  containerName: string; // 指定容器名称
  env: NodeJS.ProcessEnv;
  deps: Pick<ContainerTargetDeps, "spawnSync">;
}): (ContainerRuntimeExec & { containerName: string }) | null {
  const matches: Array<ContainerRuntimeExec & { containerName: string }> = [];
  const candidates = candidateContainerRuntimes();
  for (const exec of candidates) {
    if (
      isContainerRunning({
        exec,
        containerName: params.containerName,
        deps: params.deps,
      })
    ) {
      matches.push({ ...exec, containerName: params.containerName });
      if (exec.runtime === "docker") {
        break;
      }
    }
  }
  if (matches.length === 0) {
    return null;
  }
  if (matches.length > 1) {
    const runtimes = matches.map((match) => match.runtime).join(", ");
    throw new Error(
      `Container "${params.containerName}" is running under multiple runtimes (${runtimes}); use a unique container name.`,
    );
  }
  return matches[0];
}

function buildContainerExecArgs(params: {
  exec: ContainerRuntimeExec;
  containerName: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
}): string[] {
  const envFlag = params.exec.runtime === "docker" ? "-e" : "--env";
  const proxyUrl = normalizeOptionalString(params.env.OPENCLAW_PROXY_URL);
  if (proxyUrl) {
    assertContainerProxyUrlIsReachable(proxyUrl, params.env);
  }
  const proxyEnvArgs = proxyUrl ? [envFlag, `OPENCLAW_PROXY_URL=${proxyUrl}`] : [];
  const interactiveFlags = ["-i", ...(params.stdinIsTTY && params.stdoutIsTTY ? ["-t"] : [])];
  return [
    ...params.exec.argsPrefix,
    "exec",
    ...interactiveFlags,
    envFlag,
    `OPENCLAW_CONTAINER_HINT=${params.containerName}`,
    envFlag,
    "OPENCLAW_CLI_CONTAINER_BYPASS=1",
    ...proxyEnvArgs,
    params.containerName,
    "openclaw",
    ...params.argv,
  ];
}

function assertContainerProxyUrlIsReachable(proxyUrl: string, env: NodeJS.ProcessEnv): void {
  if (env[CONTAINER_ALLOW_LOOPBACK_PROXY_URL_ENV] === "1") {
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(proxyUrl);
  } catch {
    return;
  }
  if (!isLoopbackProxyHostname(parsed.hostname)) {
    return;
  }
  throw new Error(
    `OPENCLAW_PROXY_URL=${redactProxyUrlForMessage(proxyUrl)} is loopback; 127.0.0.1 inside a container points at the container, not the host. ` +
      `Use a container-reachable proxy address, or set ${CONTAINER_ALLOW_LOOPBACK_PROXY_URL_ENV}=1 if this is intentional.`,
  );
}

function isLoopbackProxyHostname(hostname: string): boolean {
  const normalizedHostname = hostname.toLowerCase().replace(/\.+$/, "");
  if (normalizedHostname === "localhost") {
    return true;
  }
  if (isIP(normalizedHostname) === 4) {
    return normalizedHostname.split(".", 1)[0] === "127";
  }
  const ipv6Hostname = normalizedHostname.replace(/^\[|\]$/g, "");
  if (isIP(ipv6Hostname) !== 6) {
    return false;
  }
  if (ipv6Hostname === "::1" || ipv6Hostname === "0:0:0:0:0:0:0:1") {
    return true;
  }
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ipv6Hostname);
  if (!mapped) {
    return false;
  }
  const high = Number.parseInt(mapped[1], 16);
  return Number.isInteger(high) && high >= 0x7f00 && high <= 0x7fff;
}

function redactProxyUrlForMessage(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.username || url.password) {
      url.username = "redacted";
      url.password = url.password ? "redacted" : "";
    }
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "<invalid URL>";
  }
}

function buildContainerExecEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  // Container-targeted CLI invocations should use the container's own profile
  // and gateway auth/runtime state rather than inheriting host overrides.
  delete next.OPENCLAW_PROFILE;
  delete next.OPENCLAW_GATEWAY_PORT;
  delete next.OPENCLAW_GATEWAY_URL;
  delete next.OPENCLAW_GATEWAY_TOKEN;
  delete next.OPENCLAW_GATEWAY_PASSWORD;
  // The child CLI should render container-aware follow-up commands via
  // OPENCLAW_CONTAINER_HINT, but it should not treat itself as still
  // container-targeted for validation/routing.
  next.OPENCLAW_CONTAINER = "";
  return next;
}

// 可能是在容器中运行 CLI，
// 如果 argv 中包含 --container 参数或者环境变量 OPENCLAW_CONTAINER 被设置，
// 则尝试在容器中执行 CLI 命令，并返回执行结果；
function isBlockedContainerCommand(argv: string[]): boolean {
  if (resolveCliArgvInvocation(["node", "openclaw", ...argv]).primary === "update") {
    // 如果命令行参数中包含 "update" 主命令，则返回 true，
    // 指示这是一个被阻止的容器命令，因为在容器中执行更新操作可能不受支持或不安全。
    return true;
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg || arg === FLAG_TERMINATOR) {
      return false;
    }
    if (arg === "--update") {
      // 如果命令行参数中包含 "--update" 选项，则返回 true，
      return true;
    }
    const consumedRootOption = consumeRootOptionToken(argv, i);
    if (consumedRootOption > 0) {
      i += consumedRootOption - 1;
      continue;
    }
    if (!arg.startsWith("-")) {
      return false;
    }
  }
  return false;
}

// 可能是在容器中运行 CLI，
// 如果 argv 中包含 --container 参数或者环境变量 OPENCLAW_CONTAINER 被设置，
export function maybeRunCliInContainer(
  argv: string[],
  deps?: Partial<ContainerTargetDeps>,
): CliContainerTargetResult {
  const resolvedDeps: ContainerTargetDeps = {
    env: deps?.env ?? process.env,
    spawnSync: deps?.spawnSync ?? spawnSync,
    stdinIsTTY: deps?.stdinIsTTY ?? process.stdin.isTTY,
    stdoutIsTTY: deps?.stdoutIsTTY ?? process.stdout.isTTY,
  };

  if (resolvedDeps.env.OPENCLAW_CLI_CONTAINER_BYPASS === "1") {
    return { handled: false, argv };
  }

  const parsed = parseCliContainerArgs(argv);
  if (!parsed.ok) {
    // 解析错误，抛出异常，CLI 启动流程会捕获这个异常并输出错误信息后退出。
    throw new Error(parsed.error);
  }
  const containerName = resolveCliContainerTarget(argv, resolvedDeps.env);
  if (!containerName) {
    // 不运行在容器中，继续正常的 CLI 启动流程，返回 handled: false 和原始 argv 以供后续处理。
    return { handled: false, argv: parsed.argv };
  }
  // 运行在容器中，尝试在容器中执行 CLI 命令，并返回执行结果。
  if (isBlockedContainerCommand(parsed.argv.slice(2))) {
    // 如果这是一个被阻止的容器命令（例如包含 "update" 主命令或 "--update" 选项），
    // 则抛出异常，提示用户这个命令不支持在容器中运行。
    throw new Error(
      "openclaw update is not supported with --container; rebuild or restart the container image instead.",
    );
  }

  const runningContainer = resolveRunningContainer({
    containerName,
    env: resolvedDeps.env,
    deps: resolvedDeps,
  });
  if (!runningContainer) {
    // 没有找到正在运行的容器，抛出异常，提示用户没有找到匹配的容器。
    throw new Error(`No running container matched "${containerName}" under podman or docker.`);
  }

  const result = resolvedDeps.spawnSync(
    runningContainer.command,
    buildContainerExecArgs({
      exec: runningContainer,
      containerName: runningContainer.containerName,
      argv: parsed.argv.slice(2),
      env: resolvedDeps.env,
      stdinIsTTY: resolvedDeps.stdinIsTTY,
      stdoutIsTTY: resolvedDeps.stdoutIsTTY,
    }),
    {
      stdio: "inherit",
      env: buildContainerExecEnv(resolvedDeps.env),
    },
  );
  // 运行完成。
  return {
    handled: true,
    exitCode: typeof result.status === "number" ? result.status : 1,
  };
}
