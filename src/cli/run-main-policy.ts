import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveManifestCommandAliasOwnerInRegistry,
  type PluginManifestCommandAliasRecord,
  type PluginManifestCommandAliasRegistry,
} from "../plugins/manifest-command-aliases.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "../shared/string-coerce.js";
import { resolveCliArgvInvocation } from "./argv-invocation.js";
import {
  resolveCliCommandPathPolicy,
  resolveCliNetworkProxyPolicy,
} from "./command-path-policy.js";
import { isReservedNonPluginCommandRoot } from "./command-registration-policy.js";

const ROOT_HELP_ALIASES = new Set(["tools"]);

// 把 openclaw --update 标志重写为 openclaw update 命令，
// 以便在命令路径解析中正确识别和应用策略配置。
export function rewriteUpdateFlagArgv(argv: string[]): string[] {
  const index = argv.indexOf("--update");
  if (index === -1) {
    return argv;
  }

  const next = [...argv];
  // 将 --update 标志重写为 update 命令，以便在命令路径解析中正确识别和应用策略配置。
  next.splice(index, 1, "update");
  return next;
}

// 是否 确保 CLI 路径的存在，依据是当前命令路径的策略配置。
export function shouldEnsureCliPath(argv: string[]): boolean {
  const invocation = resolveCliArgvInvocation(argv);
  if (invocation.hasHelpOrVersion || shouldStartCrestodianForBareRoot(argv)) {
    //
    return false;
  }
  return resolveCliCommandPathPolicy(invocation.commandPath).ensureCliPath;
}

// 是否 启动 CLI 代理，依据是当前命令路径的策略配置和环境变量设置。
export function shouldUseRootHelpFastPath(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const invocation = resolveCliArgvInvocation(argv);
  return (
    env.OPENCLAW_DISABLE_CLI_STARTUP_HELP_FAST_PATH !== "1" &&
    (invocation.isRootHelpInvocation ||
      (invocation.commandPath.length === 1 &&
        ROOT_HELP_ALIASES.has(invocation.commandPath[0] ?? "") &&
        invocation.hasHelpOrVersion) ||
      (invocation.commandPath.length === 1 &&
        invocation.commandPath[0] === "help" &&
        invocation.hasHelpOrVersion))
  );
}

export function shouldUseBrowserHelpFastPath(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.OPENCLAW_DISABLE_CLI_STARTUP_HELP_FAST_PATH === "1") {
    return false;
  }
  const invocation = resolveCliArgvInvocation(argv);
  return (
    invocation.commandPath.length === 1 &&
    invocation.commandPath[0] === "browser" &&
    invocation.hasHelpOrVersion
  );
}

// 通过 openclaw 命令启动 Crestodian，（自行修复）
export function shouldStartCrestodianForBareRoot(argv: string[]): boolean {
  const invocation = resolveCliArgvInvocation(argv);
  //如果没有 命令路径，并且不是帮助或版本信息的调用，
  // 执行 openclaw 会进入这种模式。
  return invocation.commandPath.length === 0 && !invocation.hasHelpOrVersion;
}

// 通过 openclaw onboard --modern 命令启动 Crestodian （初始化）
export function shouldStartCrestodianForModernOnboard(argv: string[]): boolean {
  const invocation = resolveCliArgvInvocation(argv);
  return (
    invocation.commandPath[0] === "onboard" &&
    argv.includes("--modern") &&
    !invocation.hasHelpOrVersion
  );
}

// 判断 是否应该为 CLI 启动代理，
// 依据是当前命令路径的策略配置和环境变量设置。
export function shouldStartProxyForCli(argv: string[]): boolean {
  const policyArgv = rewriteUpdateFlagArgv(argv);
  const invocation = resolveCliArgvInvocation(policyArgv);
  const [primary] = invocation.commandPath;
  if (invocation.hasHelpOrVersion || !primary) {
    // 如果是帮助或版本信息的调用，
    // 或者没有主命令，
    // 则不启动代理。
    return false;
  }
  return resolveCliNetworkProxyPolicy(policyArgv) === "default";
}

export function resolveMissingPluginCommandMessage(
  pluginId: string,
  config?: OpenClawConfig,
  options?: {
    registry?: PluginManifestCommandAliasRegistry;
    resolveCommandAliasOwner?: (params: {
      command: string | undefined;
      config?: OpenClawConfig;
      registry?: PluginManifestCommandAliasRegistry;
    }) => PluginManifestCommandAliasRecord | undefined;
  },
): string | null {
  const normalizedPluginId = normalizeLowercaseStringOrEmpty(pluginId);
  if (!normalizedPluginId) {
    return null;
  }
  const allow =
    Array.isArray(config?.plugins?.allow) && config.plugins.allow.length > 0
      ? config.plugins.allow
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => normalizeOptionalLowercaseString(entry))
          .filter(Boolean)
      : [];
  const commandAlias = options?.registry
    ? resolveManifestCommandAliasOwnerInRegistry({
        command: normalizedPluginId,
        registry: options.registry,
      })
    : options?.resolveCommandAliasOwner?.({
        command: normalizedPluginId,
        config,
        ...(options?.registry ? { registry: options.registry } : {}),
      });
  const parentPluginId = commandAlias?.pluginId;
  if (parentPluginId) {
    if (allow.length > 0 && !allow.includes(parentPluginId)) {
      return (
        `"${normalizedPluginId}" is not a plugin; it is a command provided by the ` +
        `"${parentPluginId}" plugin. Add "${parentPluginId}" to \`plugins.allow\` ` +
        `instead of "${normalizedPluginId}".`
      );
    }
    if (config?.plugins?.entries?.[parentPluginId]?.enabled === false) {
      return (
        `The \`openclaw ${normalizedPluginId}\` command is unavailable because ` +
        `\`plugins.entries.${parentPluginId}.enabled=false\`. Re-enable that entry if you want ` +
        "the bundled plugin command surface."
      );
    }
    if (commandAlias.kind === "runtime-slash") {
      const cliHint = commandAlias.cliCommand
        ? `Use \`openclaw ${commandAlias.cliCommand}\` for related CLI operations, or `
        : "Use ";
      return (
        `"${normalizedPluginId}" is a runtime slash command (/${normalizedPluginId}), not a CLI command. ` +
        `It is provided by the "${parentPluginId}" plugin. ` +
        `${cliHint}\`/${normalizedPluginId}\` in a chat session.`
      );
    }
  }

  if (isReservedNonPluginCommandRoot(normalizedPluginId)) {
    return null;
  }

  if (allow.length > 0 && !allow.includes(normalizedPluginId)) {
    if (parentPluginId && allow.includes(parentPluginId)) {
      return null;
    }
    return (
      `The \`openclaw ${normalizedPluginId}\` command is unavailable because ` +
      `\`plugins.allow\` excludes "${normalizedPluginId}". Add "${normalizedPluginId}" to ` +
      `\`plugins.allow\` if you want that bundled plugin CLI surface.`
    );
  }
  if (config?.plugins?.entries?.[normalizedPluginId]?.enabled === false) {
    return (
      `The \`openclaw ${normalizedPluginId}\` command is unavailable because ` +
      `\`plugins.entries.${normalizedPluginId}.enabled=false\`. Re-enable that entry if you want ` +
      "the bundled plugin CLI surface."
    );
  }
  return null;
}
