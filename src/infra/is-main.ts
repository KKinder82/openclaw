import fs from "node:fs";
import path from "node:path";

type IsMainModuleOptions = {
  currentFile: string;
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  wrapperEntryPairs?: Array<{
    wrapperBasename: string;
    entryBasename: string;
  }>;
};

// 标准化路径
// candidate：要标准化的路径字符串，可能是 undefined。
// cwd：当前工作目录，用于解析相对路径。
// 返回值：如果 candidate 是 undefined，则返回 undefined；
// 否则返回 candidate 的绝对路径，并尝试解析符号链接，如果解析失败则返回绝对路径。
function normalizePathCandidate(candidate: string | undefined, cwd: string): string | undefined {
  if (!candidate) {
    return undefined;
  }

  const resolved = path.resolve(cwd, candidate);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

// 判断当前模块是否为主模块的函数，
// 基于多个条件进行判断，包括直接比较路径、PM2 特定环境变量以及可选的包装器-入口映射。
export function isMainModule({
  currentFile,
  argv = process.argv,
  env = process.env,
  cwd = process.cwd(),
  wrapperEntryPairs = [],
}: IsMainModuleOptions): boolean {
  const normalizedCurrent = normalizePathCandidate(currentFile, cwd);
  // openclaw gateway =>
  // node openclaw.js gateway ...
  // argv[1] = openclaw.js
  const normalizedArgv1 = normalizePathCandidate(argv[1], cwd);

  if (normalizedCurrent && normalizedArgv1 && normalizedCurrent === normalizedArgv1) {
    return true;
  }

  // PM2 runs the script via an internal wrapper; `argv[1]` points at the wrapper.
  // PM2 exposes the actual script path in `pm_exec_path`.
  const normalizedPmExecPath = normalizePathCandidate(env.pm_exec_path, cwd);
  if (normalizedCurrent && normalizedPmExecPath && normalizedCurrent === normalizedPmExecPath) {
    return true;
  }

  // Optional wrapper->entry mapping for wrapper launchers that import the real entry.
  if (normalizedCurrent && normalizedArgv1 && wrapperEntryPairs.length > 0) {
    const currentBase = path.basename(normalizedCurrent);
    const argvBase = path.basename(normalizedArgv1);
    const matched = wrapperEntryPairs.some(
      ({ wrapperBasename, entryBasename }) =>
        currentBase === entryBasename && argvBase === wrapperBasename,
    );
    if (matched) {
      return true;
    }
  }

  return false;
}
