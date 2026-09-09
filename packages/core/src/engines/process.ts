import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompressionError } from "../errors.js";

export interface RunProcessOptions {
  signal?: AbortSignal;
  /** Wall-clock budget for the child. Exceeding it fails with JOB_TIMEOUT. */
  timeoutMs?: number;
  allowedExitCodes?: number[];
  /** Cap for captured stderr bytes. Defaults to 16 KiB. */
  maxStderrBytes?: number;
  /** Cap for captured stdout bytes. Defaults to 32 MiB. */
  maxStdoutBytes?: number;
  /** Private working directory for the child. Defaults to the OS temp dir. */
  cwd?: string;
  /** Private scratch directory exposed through TMPDIR, TMP, and TEMP. */
  tempDir?: string;
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const DEFAULT_MAX_STDERR_BYTES = 16 * 1024;
const DEFAULT_MAX_STDOUT_BYTES = 32 * 1024 * 1024;
const KILL_CONFIRMATION_TIMEOUT_MS = 1_000;

/**
 * Keys a native PDF parser may observe. The child never inherits the full
 * caller environment (no shell, no forwarded secrets); Ghostscript and qpdf
 * only need path lookup, temp directories, and locale/font discovery.
 */
const MINIMAL_ENV_KEYS = [
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "TMPDIR",
  "TMP",
  "TEMP",
  "HOME",
  "USERPROFILE",
  "LANG",
  "LC_ALL",
  "LC_MESSAGES",
  "XDG_CACHE_HOME",
  "FONTCONFIG_PATH",
  "FONTCONFIG_FILE"
];

export function minimalProcessEnv(tempDir?: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of MINIMAL_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  if (env["XDG_CACHE_HOME"] === undefined) {
    env["XDG_CACHE_HOME"] = join(tmpdir(), "pdf-compressor-cache");
  }
  if (tempDir !== undefined) {
    env["TMPDIR"] = tempDir;
    env["TMP"] = tempDir;
    env["TEMP"] = tempDir;
    env["XDG_CACHE_HOME"] = join(tempDir, "cache");
  }
  return env;
}

function killProcessGroup(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      // Negative pid targets the whole process group (spawned detached).
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // Fall through to direct kill below.
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // Best effort: the close handler below settles the promise regardless.
  }
}

/**
 * Run a native tool with an argument array (never a shell string), closed
 * stdin, no extra descriptors, a minimal environment, bounded output, and
 * whole-process-group termination on abort or timeout.
 *
 * Exit code 3 (qpdf "success with warnings") is NOT treated specially here:
 * callers opt in via `allowedExitCodes` and surface stderr as warnings.
 */
export async function runProcess(
  command: string,
  args: readonly string[],
  options: RunProcessOptions = {}
): Promise<ProcessResult> {
  if (options.signal?.aborted) {
    throw new CompressionError("JOB_CANCELLED", "Native operation was cancelled before it started.");
  }

  const allowedExitCodes = options.allowedExitCodes ?? [0];
  const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
  const maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;

  return new Promise<ProcessResult>((resolve, reject) => {
    let settled = false;
    let terminationError: CompressionError | null = null;
    let killConfirmationTimer: ReturnType<typeof setTimeout> | undefined;
    const settleResolve = (result: ProcessResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const settleReject = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    let child: ChildProcess;
    try {
      child = spawn(command, [...args], {
        stdio: ["ignore", "pipe", "pipe"],
        env: minimalProcessEnv(options.tempDir),
        cwd: options.cwd ?? tmpdir(),
        detached: process.platform !== "win32",
        windowsHide: true
      });
    } catch (error) {
      reject(new CompressionError("ENGINE_FAILED", `${command} failed to start.`, { command }));
      return;
    }

    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stderrTruncated = false;
    let stdout = "";
    let stderr = "";

    const requestTermination = (error: CompressionError): void => {
      if (settled || terminationError) return;
      terminationError = error;
      killProcessGroup(child);
      killConfirmationTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
        settleReject(error);
      }, KILL_CONFIRMATION_TIMEOUT_MS);
      killConfirmationTimer.unref?.();
    };

    const timer =
      options.timeoutMs !== undefined
        ? setTimeout(() => {
            requestTermination(
              new CompressionError("JOB_TIMEOUT", `${command} exceeded its ${options.timeoutMs} ms budget.`, {
                command,
                timeoutMs: options.timeoutMs
              })
            );
          }, options.timeoutMs)
        : undefined;
    timer?.unref?.();

    const onAbort = (): void => {
      requestTermination(new CompressionError("JOB_CANCELLED", `${command} was cancelled.`, { command }));
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    function cleanup(): void {
      if (timer !== undefined) clearTimeout(timer);
      if (killConfirmationTimer !== undefined) clearTimeout(killConfirmationTimer);
      options.signal?.removeEventListener("abort", onAbort);
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      if (terminationError) return;
      if (stdoutBytes + chunk.length > maxStdoutBytes) {
        requestTermination(
          new CompressionError("ENGINE_FAILED", `${command} produced more than ${maxStdoutBytes} stdout bytes.`, {
            command
          })
        );
        return;
      }
      stdoutBytes += chunk.length;
      stdout += chunk.toString("utf8");
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      if (terminationError) return;
      if (stderrBytes >= maxStderrBytes) {
        stderrTruncated = true;
        return;
      }
      const room = maxStderrBytes - stderrBytes;
      const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
      stderrBytes += slice.length;
      stderr += slice.toString("utf8");
      if (chunk.length > room) stderrTruncated = true;
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (terminationError) return;
      if (error.name === "AbortError") {
        settleReject(new CompressionError("JOB_CANCELLED", `${command} was cancelled.`, { command }));
        return;
      }
      if (error.code === "ENOENT") {
        settleReject(
          new CompressionError("ENGINE_UNAVAILABLE", `${command} is not installed or not on PATH.`, { command })
        );
        return;
      }
      settleReject(new CompressionError("ENGINE_FAILED", `${command} failed to start.`, { command }));
    });

    child.on("close", (code) => {
      if (terminationError) {
        settleReject(terminationError);
        return;
      }
      const text = (value: string): string => value.trim();
      if (code !== null && allowedExitCodes.includes(code)) {
        settleResolve({
          stdout: text(stdout),
          stderr: (text(stderr) + (stderrTruncated ? "\n[stderr truncated]" : "")).trim(),
          exitCode: code
        });
        return;
      }
      settleReject(
        new CompressionError("ENGINE_FAILED", `${command} exited with code ${code}.`, {
          command,
          exitCode: code,
          stderr: text(stderr).slice(0, 2000)
        })
      );
    });
  });
}
