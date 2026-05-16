export const FLAG_TERMINATOR = "--";

// 不含有值的（BOOL）根级选项（即全局选项）通常出现在命令行的开头，不含有值。
// 例如 --dev。
const ROOT_BOOLEAN_FLAGS = new Set(["--dev", "--no-color"]);
// 含有值的根级选项（即全局选项），这些选项后面通常会跟一个值，
// 例如 --profile production 或 --log-level=debug。
const ROOT_VALUE_FLAGS = new Set(["--profile", "--log-level", "--container"]);

//是否是一个值标记（即不是选项标记，或者是一个负数或小数的选项标记），
export function isValueToken(arg: string | undefined): boolean {
  if (!arg || arg === FLAG_TERMINATOR) {
    // 没有参数或是选项终止符，不能作为值标记。
    return false;
  }
  if (!arg.startsWith("-")) {
    // 不以 - 开头的参数，显然是一个值。
    return true;
  }
  // 以 - 开头的参数，如果是一个负数或小数（例如 -1、-0.5），也应该被视为值标记。
  return /^-\d+(?:\.\d+)?$/.test(arg);
}

// 消费（去掉）根级选项（即全局选项）的命令行参数，返回消费的参数数量（0、1 或 2）。
export function consumeRootOptionToken(args: ReadonlyArray<string>, index: number): number {
  const arg = args[index];
  if (!arg) {
    return 0;
  }
  if (ROOT_BOOLEAN_FLAGS.has(arg)) {
    return 1;
  }
  if (
    arg.startsWith("--profile=") ||
    arg.startsWith("--log-level=") ||
    arg.startsWith("--container=")
  ) {
    return 1;
  }
  if (ROOT_VALUE_FLAGS.has(arg)) {
    return isValueToken(args[index + 1]) ? 2 : 1;
  }
  return 0;
}
