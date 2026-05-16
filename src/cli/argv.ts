import { isBunRuntime, isNodeRuntime } from "../daemon/runtime-binary.js";
import {
  consumeRootOptionToken,
  FLAG_TERMINATOR,
  isValueToken,
} from "../infra/cli-root-options.js";
import { CORE_CLI_COMMAND_DESCRIPTORS } from "./program/core-command-descriptors.js";
import { SUB_CLI_DESCRIPTORS } from "./program/subcli-descriptors.js";

const HELP_FLAGS = new Set(["-h", "--help"]);
const VERSION_FLAGS = new Set(["-V", "--version"]);
const ROOT_VERSION_ALIAS_FLAG = "-v"; // 作为 --version 的别名，提供更简短的选项形式，方便用户快速查看版本信息。
const ROOT_COMMAND_DESCRIPTORS = [...CORE_CLI_COMMAND_DESCRIPTORS, ...SUB_CLI_DESCRIPTORS];
const KNOWN_ROOT_COMMANDS: ReadonlySet<string> = new Set(
  ROOT_COMMAND_DESCRIPTORS.map((descriptor) => descriptor.name),
);
const ROOT_COMMANDS_WITH_SUBCOMMANDS: ReadonlySet<string> = new Set(
  ROOT_COMMAND_DESCRIPTORS.filter((descriptor) => descriptor.hasSubcommands).map(
    (descriptor) => descriptor.name,
  ),
);

export function hasHelpOrVersion(argv: string[]): boolean {
  return (
    argv.some((arg) => HELP_FLAGS.has(arg) || VERSION_FLAGS.has(arg)) || hasRootVersionAlias(argv)
  );
}

// 判断是否是根帮助调用
// 如果 argv 中包含 --help 参数或者 -h 参数，并且这些参数不是某个子命令的选项参数，
// 或者有 -v 参数（作为 --version 的别名），则认为这是一个根帮助调用，应该直接输出帮助信息并退出，而不需要加载和启动整个 CLI 应用。

export function isHelpOrVersionInvocation(argv: string[]): boolean {
  if (hasRootVersionAlias(argv)) {
    // 如果包含 -v 参数（作为 --version 的别名），则认为这是一个根版本调用，应该直接输出版本信息并退出，而不需要加载和启动整个 CLI 应用。
    return true;
  }

  const args = argv.slice(2);
  let sawCommandOption = false;
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg || arg === FLAG_TERMINATOR) {
      // 遇到选项终止符 --，停止解析。
      break;
    }
    const rootConsumed = consumeRootOptionToken(args, i);
    if (rootConsumed > 0) {
      i += rootConsumed - 1;
      continue;
    }
    if (HELP_FLAGS.has(arg) || VERSION_FLAGS.has(arg)) {
      // 包含 --help 参数或者 -h 参数，
      // 包含 --version 参数或者 -V 参数，
      return true;
    }
    if (arg.startsWith("-")) {
      // 跳过选项参数。
      sawCommandOption = true;
      continue;
    }
    // 位置参数
    positionals.push(arg);
    if (arg !== "help") {
      continue;
    }
    // 也就是说，如果遇到 help 位置参数，
    // 那么如果之前已经遇到过选项参数，那么后续的 help 可能是某个子命令的选项参数，而不是根帮助调用。
    if (sawCommandOption) {
      // 如果己经遇到过 选项参数，那么后续的 help 可能是某个子命令的选项参数，而不是根帮助调用。
      return false;
    }
    // 如果没有遇到过选项参数，那么 help 位置参数可能是根帮助调用，
    if (positionals.length === 1) {
      return true;
    }
    const [primary] = positionals;
    // Positional `help` may be a command argument for known leaf commands.
    // Unknown roots are treated as plugin command namespaces.
    if (!primary || !KNOWN_ROOT_COMMANDS.has(primary)) {
      return true;
    }
    if (positionals.length === 2 && ROOT_COMMANDS_WITH_SUBCOMMANDS.has(primary)) {
      return true;
    }
    return false;
  }
  return false;
}

function parsePositiveInt(value: string): number | undefined {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

export function hasFlag(argv: string[], name: string): boolean {
  const args = argv.slice(2);
  for (const arg of args) {
    if (arg === FLAG_TERMINATOR) {
      break;
    }
    if (arg === name) {
      return true;
    }
  }
  return false;
}

export function hasRootVersionAlias(argv: string[]): boolean {
  const args = argv.slice(2);
  let hasAlias = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg) {
      continue;
    }
    if (arg === FLAG_TERMINATOR) {
      // 遇到选项终止符 --，停止解析。
      break;
    }
    if (arg === ROOT_VERSION_ALIAS_FLAG) {
      hasAlias = true;
      continue;
    }
    const consumed = consumeRootOptionToken(args, i);
    if (consumed > 0) {
      i += consumed - 1;
      continue;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    return false;
  }
  return hasAlias;
}

export function isRootVersionInvocation(argv: string[]): boolean {
  return isRootInvocationForFlags(argv, VERSION_FLAGS, { includeVersionAlias: true });
}

// 判断是否是全局调用，
// 如果 argv 中包含 --version 参数或者 -v 参数，并且这些参数不是某个子命令的选项参数，
// 则认为这是一个根版本调用，应该直接输出版本信息并退出，而不需要加载和启动整个 CLI 应用。
function isRootInvocationForFlags(
  argv: string[],
  targetFlags: Set<string>,
  options?: { includeVersionAlias?: boolean },
): boolean {
  const args = argv.slice(2);
  let hasTarget = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg) {
      // 跳过空参数。
      continue;
    }
    if (arg === FLAG_TERMINATOR) {
      // 遇到全局选项终止符 --，停止解析。
      break;
    }
    if (
      targetFlags.has(arg) ||
      (options?.includeVersionAlias === true && arg === ROOT_VERSION_ALIAS_FLAG)
    ) {
      hasTarget = true;
      continue;
    }
    const consumed = consumeRootOptionToken(args, i);
    if (consumed > 0) {
      i += consumed - 1;
      continue;
    }
    // Unknown flags and subcommand-scoped help/version should fall back to Commander.
    return false;
  }
  return hasTarget;
}

// 判断是否是根帮助调用，
export function isRootHelpInvocation(argv: string[]): boolean {
  return isRootInvocationForFlags(argv, HELP_FLAGS);
}

export function getFlagValue(argv: string[], name: string): string | null | undefined {
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === FLAG_TERMINATOR) {
      break;
    }
    if (arg === name) {
      const next = args[i + 1];
      return isValueToken(next) ? next : null;
    }
    if (arg.startsWith(`${name}=`)) {
      const value = arg.slice(name.length + 1);
      return value ? value : null;
    }
  }
  return undefined;
}

export function getVerboseFlag(argv: string[], options?: { includeDebug?: boolean }): boolean {
  if (hasFlag(argv, "--verbose")) {
    return true;
  }
  if (options?.includeDebug && hasFlag(argv, "--debug")) {
    return true;
  }
  return false;
}

export function getPositiveIntFlagValue(argv: string[], name: string): number | null | undefined {
  const raw = getFlagValue(argv, name);
  if (raw === null || raw === undefined) {
    return raw;
  }
  return parsePositiveInt(raw);
}

// 获取命令路径，包含根级选项（即全局选项），以便在某些情况下需要考虑全局选项对命令解析的影响。
export function getCommandPath(argv: string[], depth = 2): string[] {
  return getCommandPathInternal(argv, depth, { skipRootOptions: false });
}

// 获取命令路径，跳过根级选项（即全局选项），以便更准确地识别子命令和位置参数。
export function getCommandPathWithRootOptions(argv: string[], depth = 2): string[] {
  return getCommandPathInternal(argv, depth, { skipRootOptions: true });
}

// 内部函数用于解析命令路径，根据是否跳过根级选项来调整解析逻辑。
// CommandPath 的解析会从 argv 中提取非选项参数 （即不以 "-" 开头的参数），
// 并根据指定的深度返回前几个命令路径组件。
function getCommandPathInternal(
  argv: string[],
  depth: number, // 返回数量
  opts: { skipRootOptions: boolean },
): string[] {
  const args = argv.slice(2); // 从第3个参数开始解析，前两个通常是 node 和脚本路径
  const path: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg) {
      // 跳过空参数。
      continue;
    }
    if (arg === "--") {
      // 遇到选项终止符，停止解析命令路径。
      break;
    }
    if (opts.skipRootOptions) {
      // 如果启用跳过根级选项，
      // 则在解析命令路径时会忽略全局选项（即根级选项），以便更准确地识别子命令和位置参数。
      const consumed = consumeRootOptionToken(args, i);
      if (consumed > 0) {
        i += consumed - 1;
        continue;
      }
    }
    if (arg.startsWith("-")) {
      // 跳过选项参数。
      continue;
    }
    path.push(arg);
    if (path.length >= depth) {
      // 达到指定深度，停止解析。
      break;
    }
  }
  return path;
}

// 获取主要命令 第一个
export function getPrimaryCommand(argv: string[]): string | null {
  const [primary] = getCommandPathWithRootOptions(argv, 1);
  return primary ?? null;
}

type CommandPositionalsParseOptions = {
  commandPath: ReadonlyArray<string>;
  booleanFlags?: ReadonlyArray<string>;
  valueFlags?: ReadonlyArray<string>;
};

function consumeKnownOptionToken(
  args: ReadonlyArray<string>,
  index: number,
  booleanFlags: ReadonlySet<string>,
  valueFlags: ReadonlySet<string>,
): number {
  const arg = args[index];
  if (!arg || arg === FLAG_TERMINATOR || !arg.startsWith("-")) {
    return 0;
  }

  const equalsIndex = arg.indexOf("=");
  const flag = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);

  if (booleanFlags.has(flag)) {
    return equalsIndex === -1 ? 1 : 0;
  }

  if (!valueFlags.has(flag)) {
    return 0;
  }

  if (equalsIndex !== -1) {
    const value = arg.slice(equalsIndex + 1).trim();
    return value ? 1 : 0;
  }

  return isValueToken(args[index + 1]) ? 2 : 0;
}

export function getCommandPositionalsWithRootOptions(
  argv: string[],
  options: CommandPositionalsParseOptions,
): string[] | null {
  const args = argv.slice(2);
  const commandPath = options.commandPath;
  const booleanFlags = new Set(options.booleanFlags ?? []);
  const valueFlags = new Set(options.valueFlags ?? []);
  const positionals: string[] = [];
  let commandIndex = 0;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg || arg === FLAG_TERMINATOR) {
      break;
    }

    const rootConsumed = consumeRootOptionToken(args, i);
    if (rootConsumed > 0) {
      i += rootConsumed - 1;
      continue;
    }

    if (arg.startsWith("-")) {
      const optionConsumed = consumeKnownOptionToken(args, i, booleanFlags, valueFlags);
      if (optionConsumed === 0) {
        return null;
      }
      i += optionConsumed - 1;
      continue;
    }

    if (commandIndex < commandPath.length) {
      if (arg !== commandPath[commandIndex]) {
        return null;
      }
      commandIndex += 1;
      continue;
    }

    positionals.push(arg);
  }

  if (commandIndex < commandPath.length) {
    return null;
  }
  return positionals;
}

export function buildParseArgv(params: {
  programName?: string;
  rawArgs?: string[];
  fallbackArgv?: string[];
}): string[] {
  const baseArgv =
    params.rawArgs && params.rawArgs.length > 0
      ? params.rawArgs
      : params.fallbackArgv && params.fallbackArgv.length > 0
        ? params.fallbackArgv
        : process.argv;
  const programName = params.programName ?? "";
  const normalizedArgv =
    programName && baseArgv[0] === programName
      ? baseArgv.slice(1)
      : baseArgv[0]?.endsWith("openclaw")
        ? baseArgv.slice(1)
        : baseArgv;
  const looksLikeNode =
    normalizedArgv.length >= 2 &&
    (isNodeRuntime(normalizedArgv[0] ?? "") || isBunRuntime(normalizedArgv[0] ?? ""));
  if (looksLikeNode) {
    return normalizedArgv;
  }
  return ["node", programName || "openclaw", ...normalizedArgv];
}

export function shouldMigrateStateFromPath(path: string[]): boolean {
  if (path.length === 0) {
    return true;
  }
  const [primary, secondary] = path;
  if (primary === "health" || primary === "status" || primary === "sessions") {
    return false;
  }
  if (primary === "update" && secondary === "status") {
    return false;
  }
  if (primary === "config" && (secondary === "get" || secondary === "unset")) {
    return false;
  }
  if (primary === "models" && (secondary === "list" || secondary === "status")) {
    return false;
  }
  if (primary === "agent") {
    return false;
  }
  return true;
}

export function shouldMigrateState(argv: string[]): boolean {
  return shouldMigrateStateFromPath(getCommandPath(argv, 2));
}
