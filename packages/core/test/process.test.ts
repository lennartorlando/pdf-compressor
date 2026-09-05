import { describe, expect, it } from "vitest";
import { minimalProcessEnv, runProcess } from "../src/engines/process.js";

const NODE = process.execPath;

describe("hardened native process wrapper", () => {
  it("captures stdout and stderr without a shell", async () => {
    const result = await runProcess(NODE, ["-e", "process.stdout.write('out');process.stderr.write('err');"]);
    expect(result.stdout).toBe("out");
    expect(result.stderr).toBe("err");
    expect(result.exitCode).toBe(0);
  });

  it("closes stdin so children cannot block on input", async () => {
    const result = await runProcess(NODE, [
      "-e",
      "let data='';process.stdin.on('data',(c)=>{data+=c;});process.stdin.on('end',()=>{process.stdout.write('ended:'+data.length);});"
    ]);
    expect(result.stdout).toBe("ended:0");
  });

  it("runs with a minimal environment", () => {
    const env = minimalProcessEnv();
    expect(env["PATH"]).toBe(process.env["PATH"]);
    expect(env["PDF_COMPRESSOR_TEST_SECRET"]).toBeUndefined();
    expect(Object.keys(env).length).toBeLessThanOrEqual(16);
  });

  it("does not leak caller secrets into the child environment", async () => {
    process.env["PDF_COMPRESSOR_TEST_SECRET"] = "s3cret";
    try {
      const result = await runProcess(NODE, ["-e", "process.stdout.write(process.env.PDF_COMPRESSOR_TEST_SECRET ?? 'absent');"]);
      expect(result.stdout).toBe("absent");
    } finally {
      delete process.env["PDF_COMPRESSOR_TEST_SECRET"];
    }
  });

  it("maps a missing binary to ENGINE_UNAVAILABLE", async () => {
    await expect(runProcess("pdf-compressor-definitely-missing-binary", ["--version"])).rejects.toMatchObject({
      code: "ENGINE_UNAVAILABLE"
    });
  });

  it("maps nonzero exits to ENGINE_FAILED but allows exit 3 opt-in", async () => {
    await expect(runProcess(NODE, ["-e", "process.exit(2);"])).rejects.toMatchObject({ code: "ENGINE_FAILED" });
    const warnings = await runProcess(NODE, ["-e", "process.stderr.write('warn');process.exit(3);"], {
      allowedExitCodes: [0, 3]
    });
    expect(warnings.exitCode).toBe(3);
    expect(warnings.stderr).toBe("warn");
  });

  it("enforces a timeout with JOB_TIMEOUT and terminates the group", async () => {
    const started = Date.now();
    await expect(
      runProcess(NODE, ["-e", "setInterval(()=>{},1000);"], { timeoutMs: 200 })
    ).rejects.toMatchObject({ code: "JOB_TIMEOUT" });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("propagates abort as JOB_CANCELLED", async () => {
    const controller = new AbortController();
    const pending = runProcess(NODE, ["-e", "setInterval(()=>{},1000);"], { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "JOB_CANCELLED" });
  });

  it("rejects immediately when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runProcess(NODE, ["-e", "1"], { signal: controller.signal })).rejects.toMatchObject({
      code: "JOB_CANCELLED"
    });
  });

  it("bounds stderr output", async () => {
    const result = await runProcess(NODE, ["-e", "process.stderr.write('x'.repeat(100000));"], {
      maxStderrBytes: 1024
    });
    expect(result.stderr.length).toBeLessThanOrEqual(1100);
  });
});
