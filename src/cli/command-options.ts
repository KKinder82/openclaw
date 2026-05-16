import type { Command } from "commander";

export function hasExplicitOptions(command: Command, names: readonly string[]): boolean {
  if (typeof command.getOptionValueSource !== "function") {
    return false;
  }
  return names.some((name) => command.getOptionValueSource(name) === "cli");
}

// 判断命令行参数是否表示根帮助调用，
function getOptionSource(command: Command, name: string): string | undefined {
  if (typeof command.getOptionValueSource !== "function") {
    return undefined;
  }
  return command.getOptionValueSource(name);
}

// Defensive guardrail: allow expected parent/grandparent inheritance without unbounded deep traversal.
const MAX_INHERIT_DEPTH = 2;

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Commander option values are typed by the caller.
// 从给定的命令开始，沿着父命令链向上查找，尝试继承指定选项的值。
export function inheritOptionFromParent<T = unknown>(
  command: Command | undefined,
  name: string,
): T | undefined {
  if (!command) {
    return undefined;
  }

  const childSource = getOptionSource(command, name);
  if (childSource && childSource !== "default") {
    // 当前命令已经有一个非默认来源的选项值，直接返回该值，无需继续向父命令查找。
    return undefined;
  }

  let depth = 0;
  let ancestor = command.parent;
  while (ancestor && depth < MAX_INHERIT_DEPTH) {
    const source = getOptionSource(ancestor, name);
    if (source && source !== "default") {
      // 在父命令链中找到了一个非默认来源的选项值，返回该值，完成继承。
      return ancestor.opts<Record<string, unknown>>()[name] as T | undefined;
    }
    depth += 1;
    ancestor = ancestor.parent;
  }
  return undefined;
}
