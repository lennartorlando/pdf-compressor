#!/usr/bin/env node
import { runCompressCommand, usage } from "./commands/compress.js";
import { fileURLToPath } from "node:url";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const [command, ...args] = argv;
  if (command !== "compress") {
    process.stderr.write(usage());
    return 64;
  }

  const result = await runCompressCommand(args);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.exitCode;
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((code) => {
    process.exitCode = code;
  });
}
