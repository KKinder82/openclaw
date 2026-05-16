import { FLAG_TERMINATOR } from "../infra/cli-root-options.js";
import { forwardConsumedCliRootOption } from "./root-option-forward.js";

type CliRootOptionScanResult = { ok: true; argv: string[] } | { ok: false; error: string };

type CliRootOptionVisitResult =
  | { kind: "pass" }
  | { kind: "handled"; consumedNext?: boolean }
  | { kind: "error"; error: string };

// 扫描 CLI 根选项，
// 根选项是指在 CLI 参数中以 -- 开头的选项，
// 这些选项会被 CLI 解析器在最早阶段处理，
// 以便在后续的 CLI 处理过程中可以根据这些选项调整行为或者环境变量等。
export function scanCliRootOptions(
  argv: string[],
  visit: (params: {
    arg: string;
    args: string[];
    index: number;
    out: string[]; // 己分析的的参数。
  }) => CliRootOptionVisitResult,
): CliRootOptionScanResult {
  if (argv.length < 2) {
    return { ok: true, argv };
  }

  // 下面是扫描过程，主要是从 argv 中跳过前两个元素（通常是 node 和脚本路径），
  const out: string[] = argv.slice(0, 2);
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) {
      continue;
    }
    if (arg === FLAG_TERMINATOR) {
      out.push(arg, ...args.slice(i + 1));
      break;
    }

    const visited = visit({ arg, args, index: i, out });
    // 如果访问结果是错误，则停止扫描并返回错误信息。
    if (visited.kind === "error") {
      return { ok: false, error: visited.error };
    }
    // 如果访问结果是处理过的，则根据 consumedNext 标记是否需要跳过下一个参数，
    if (visited.kind === "handled") {
      if (visited.consumedNext) {
        i += 1;
      }
      continue;
    }
    // 下面是 pass，没有处理，继续往下走，最后把这个参数放到输出数组中。
    // 如果是全局选项
    const consumedRootOption = forwardConsumedCliRootOption(args, i, out);
    if (consumedRootOption > 0) {
      i += consumedRootOption - 1;
      continue;
    }

    out.push(arg);
  }

  return { ok: true, argv: out };
}
