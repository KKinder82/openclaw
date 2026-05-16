import { consumeRootOptionToken } from "../infra/cli-root-options.js";

// 转发已被 CLI 根选项扫描器识别并消耗的 CLI 根选项，
// 这个函数会被 CLI 根选项扫描器调用，
// 当扫描器在扫描过程中遇到一个 CLI 根选项时，会调用这个函数来将这个选项转发到最终的 argv 输出中，
// 以便在后续的 CLI 处理过程中可以正确地识别和处理这些根选项。
export function forwardConsumedCliRootOption(
  args: readonly string[],
  index: number,
  out: string[],
): number {
  const consumedRootOption = consumeRootOptionToken(args, index);
  if (consumedRootOption <= 0) {
    return 0;
  }

  for (let offset = 0; offset < consumedRootOption; offset += 1) {
    const token = args[index + offset];
    if (token !== undefined) {
      out.push(token);
    }
  }

  return consumedRootOption;
}
