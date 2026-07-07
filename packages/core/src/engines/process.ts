import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompressionError } from "../errors.js";

export async function runProcess(
  command: string,
  args: string[],
  signal?: AbortSignal,
  allowedExitCodes = [0]
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      signal,
      env: {
        ...process.env,
        XDG_CACHE_HOME: process.env.XDG_CACHE_HOME ?? join(tmpdir(), "pdf-compressor-cache")
      }
    });
    let stderr = "";

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.name === "AbortError") {
        reject(new CompressionError("JOB_CANCELLED", "Compression job was cancelled."));
        return;
      }
      if (error.code === "ENOENT") {
        reject(new CompressionError("ENGINE_UNAVAILABLE", `${command} is not installed or not on PATH.`, { command }));
        return;
      }
      reject(new CompressionError("ENGINE_FAILED", `${command} failed to start.`, { command }));
    });

    child.on("close", (code) => {
      if (code !== null && allowedExitCodes.includes(code)) {
        resolve(stderr.trim());
        return;
      }
      reject(new CompressionError("ENGINE_FAILED", `${command} exited with code ${code}.`, {
        command,
        stderr: stderr.trim().slice(0, 2000)
      }));
    });
  });
}
