import {
  getCommandPathWithRootOptions,
  getPrimaryCommand,
  isHelpOrVersionInvocation,
  isRootHelpInvocation,
} from "./argv.js";

export type CliArgvInvocation = {
  argv: string[];
  commandPath: string[];
  primary: string | null;
  hasHelpOrVersion: boolean;
  isRootHelpInvocation: boolean;
};

// 解析 CLI 参数
// 以确定是否是帮助或版本信息的调用，
export function resolveCliArgvInvocation(argv: string[]): CliArgvInvocation {
  return {
    argv,
    commandPath: getCommandPathWithRootOptions(argv, 2), // 获取命令路径，跳过前两个元素（通常是 node 和脚本路径）
    primary: getPrimaryCommand(argv), // 获取主命令（命令路径的第一个元素，如果存在的话）
    hasHelpOrVersion: isHelpOrVersionInvocation(argv), // 检查是否包含帮助或版本信息的调用
    isRootHelpInvocation: isRootHelpInvocation(argv), // 检查是否是根帮助调用
  };
}
