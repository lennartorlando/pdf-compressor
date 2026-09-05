#!/usr/bin/env node
import { runCompressCommand, usage as compressUsage } from "./commands/compress.js";
import { runInspectCommand, inspectUsage } from "./commands/inspect.js";
import { runAssembleCommand, assembleUsage } from "./commands/assemble.js";
import { fileURLToPath } from "node:url";

export function usage(): string {
  return [compressUsage(), inspectUsage(), assembleUsage()].join("");
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const [command, ...args] = argv;
  if (command === "compress") {
    const result = await runCompressCommand(args);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return result.exitCode;
  }
  if (command === "inspect") {
    const result = await runInspectCommand(args);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return result.exitCode;
  }
  if (command === "assemble") {
    const result = await runAssembleCommand(args);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return result.exitCode;
  }

  process.stderr.write(usage());
  return 64;
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((code) => {
    process.exitCode = code;
  });
}
