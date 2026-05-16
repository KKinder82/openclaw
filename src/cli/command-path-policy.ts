import { isGatewayConfigBypassCommandPath } from "../gateway/explicit-connection-policy.js";
import { getCommandPathWithRootOptions } from "./argv.js";
import {
  cliCommandCatalog,
  type CliCommandPathPolicy,
  type CliNetworkProxyPolicy,
} from "./command-catalog.js";
import { matchesCommandPath } from "./command-path-matches.js";
import { resolveGatewayCatalogCommandPath } from "./gateway-run-argv.js";

const DEFAULT_CLI_COMMAND_PATH_POLICY: CliCommandPathPolicy = {
  bypassConfigGuard: false,
  routeConfigGuard: "never",
  loadPlugins: "never",
  pluginRegistry: { scope: "all" },
  hideBanner: false,
  ensureCliPath: true, // 默认情况下，确保 CLI 可执行文件在 PATH 中，以便子进程调用。
  networkProxy: "default",
};

// 解析 CLI 命令路径的策略配置，
export function resolveCliCommandPathPolicy(commandPath: string[]): CliCommandPathPolicy {
  let resolvedPolicy: CliCommandPathPolicy = { ...DEFAULT_CLI_COMMAND_PATH_POLICY };
  for (const entry of cliCommandCatalog) {
    if (!entry.policy) {
      // 如果没有策略配置，则检查下一个 命令。
      continue;
    }
    // 有策略配置的话，检查当前命令路径是否匹配这个策略配置的命令路径模式，如果不匹配，则检查下一个 命令。
    if (!matchesCommandPath(commandPath, entry.commandPath, { exact: entry.exact })) {
      // 如果当前命令路径不匹配这个策略配置的命令路径模式，则检查下一个 命令。
      continue;
    }
    // 如果匹配，则将这个策略配置应用到当前的解析结果上，覆盖之前的设置。
    Object.assign(resolvedPolicy, entry.policy);

    // 注意：即使匹配了某个策略配置，也不能停止检查后续的命令，
    // 因为后续的命令可能会有更具体的匹配模式和策略配置，从而覆盖之前的设置。
  }

  if (isGatewayConfigBypassCommandPath(commandPath)) {
    resolvedPolicy.bypassConfigGuard = true;
  }
  return resolvedPolicy;
}

function isCommandPathPrefix(commandPath: string[], pattern: readonly string[]): boolean {
  return pattern.every((segment, index) => commandPath[index] === segment);
}

// 解析 CLI 命令路径，
// 依据是当前的 CLI 参数和命令目录中的配置。
export function resolveCliCatalogCommandPath(argv: string[]): string[] {
  // 解析 CLI 命令路径，依据是当前的 CLI 参数和命令目录中的配置。
  const tokens =
    resolveGatewayCatalogCommandPath(argv) ?? getCommandPathWithRootOptions(argv, argv.length);

  if (tokens.length === 0) {
    return [];
  }
  let bestMatch: readonly string[] | null = null;
  for (const entry of cliCommandCatalog) {
    if (!isCommandPathPrefix(tokens, entry.commandPath)) {
      // 不匹配的话，检查下一个 命令。
      continue;
    }
    if (!bestMatch || entry.commandPath.length > bestMatch.length) {
      // 如果匹配的话，且这个命令路径模式比之前找到的更具体（更长），则更新最佳匹配。
      bestMatch = entry.commandPath;
    }
  }
  // 返回最佳匹配的命令路径，
  // 如果没有找到匹配，则返回 CLI 参数中的第一个元素作为命令路径。
  return bestMatch ? [...bestMatch] : [tokens[0]];
}

// 解析 CLI 网络代理策略，
// 依据是当前的 CLI 参数和命令路径的策略配置。
export function resolveCliNetworkProxyPolicy(argv: string[]): CliNetworkProxyPolicy {
  const commandPath = resolveCliCatalogCommandPath(argv);
  const networkProxy = resolveCliCommandPathPolicy(commandPath).networkProxy;
  return typeof networkProxy === "function" ? networkProxy({ argv, commandPath }) : networkProxy;
}
