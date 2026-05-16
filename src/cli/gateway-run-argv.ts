import { isValueToken } from "../infra/cli-root-options.js";

// 解析 Gateway 命令目录 是命令路径
const GATEWAY_RUN_VALUE_FLAGS = new Set([
  "--port",
  "--bind",
  "--token",
  "--auth",
  "--password",
  "--password-file",
  "--tailscale",
  "--ws-log",
  "--raw-stream-path",
]);

// boolean 标志的选项集合，
const GATEWAY_RUN_BOOLEAN_FLAGS = new Set([
  "--tailscale-reset-on-exit",
  "--allow-unconfigured",
  "--dev",
  "--reset",
  "--force",
  "--verbose",
  "--cli-backend-logs",
  "--claude-cli-logs",
  "--compact",
  "--raw-stream",
]);

// 跳过 Gateway Run 的 Option
export function consumeGatewayRunOptionToken(args: ReadonlyArray<string>, index: number): number {
  const arg = args[index];
  if (!arg || arg === "--" || !arg.startsWith("-")) {
    // 后续没有参数了，或者遇到了分隔符，或者不是一个选项了，都不消费任何参数。
    return 0;
  }
  // 后面是 选项 的情况

  const equalsIndex = arg.indexOf("=");
  // 如果 选项 包含 = ，返回 = 前面的
  // 如果 选项 不包含 = 返回整个 选项
  const flag = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
  if (GATEWAY_RUN_BOOLEAN_FLAGS.has(flag)) {
    // 属于 BOOL 选项，
    return equalsIndex === -1 ? 1 : 0; //包含 # ，返回0， 不包含 = 返回1（消费掉这个选项），
  }
  if (!GATEWAY_RUN_VALUE_FLAGS.has(flag)) {
    // 不属于已知的选项，返回 0 表示不消费任何参数。
    return 0;
  }
  // 属于需要值的选项，
  if (equalsIndex !== -1) {
    return arg.slice(equalsIndex + 1).trim() ? 1 : 0; // 包含 = 且 = 后面有值，返回 1（消费掉这个选项），否则返回 0（不消费）。
  }
  // 处理 --flag value 形式的标志，返回 2 表示这个标志和它的值一起被消费掉了，
  // 如果 后续的参数不是一个值（是一个选项，或没有了）则返回 0 （不消费）。
  return isValueToken(args[index + 1]) ? 2 : 0;
}

// 判断 Gateway 命令路径 后面的参数是否为根选项的标志，
// 如果是的话，返回这个标志占用了几个参数位置（1 或 2），否则返回 0 表示没有消费任何参数。
export function consumeGatewayFastPathRootOptionToken(
  args: ReadonlyArray<string>,
  index: number,
): number {
  const arg = args[index];
  if (!arg || arg === "--") {
    return 0;
  }
  if (arg === "--no-color") {
    return 1;
  }
  if (arg.startsWith("--profile=")) {
    // 处理 --profile=xxx 形式的标志，返回 1 表示这个标志被消费掉了
    return arg.slice("--profile=".length).trim() ? 1 : 0;
  }
  if (arg === "--profile") {
    return isValueToken(args[index + 1]) ? 2 : 0;
  }
  return 0;
}

// 解析 Gateway 命令目录 是命令路径
export function resolveGatewayCatalogCommandPath(argv: string[]): string[] | null {
  const args = argv.slice(2);
  // 是否看到了 gateway 命令，
  let sawGateway = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg || arg === "--") {
      break;
    }
    if (!sawGateway) {
      // 在看到 gateway 命令之前，优先检查根选项的标志，
      const consumed = consumeGatewayFastPathRootOptionToken(args, index);
      if (consumed > 0) {
        // 是全局选项的话，消费掉这个选项占用的参数位置，然后继续检查下一个参数。
        index += consumed - 1;
        continue;
      }
      if (arg.startsWith("-")) {
        // 选项
        continue;
      }
      if (arg !== "gateway") {
        // 在看到 gateway 命令之前，遇到了一个非选项的参数，且这个参数不是 gateway 命令，
        return null;
      }
      sawGateway = true;
      continue;
    }
    // 已经看到了 gateway 命令，继续检查后续的参数，
    const consumed = consumeGatewayRunOptionToken(args, index);
    if (consumed > 0) {
      // 是 gateway 命令的选项的话，消费掉这个选项占用的参数位置，然后继续检查下一个参数。
      index += consumed - 1;
      continue;
    }
    if (arg.startsWith("-")) {
      // 选项
      continue;
    }
    // 遇到了一个非选项的参数，且这个参数在 gateway 命令之后，
    return ["gateway", arg];
  }

  return sawGateway ? ["gateway"] : null;
}
