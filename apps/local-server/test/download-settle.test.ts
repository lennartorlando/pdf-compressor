import { describe, expect, it } from "vitest";
import { createDownloadTracker, type DownloadLeaseSink } from "../src/server.js";

function recordingSink(): DownloadLeaseSink & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    consumeSync: () => {
      calls.push("consumeSync");
    },
    release: () => {
      calls.push("release");
    },
    destroySource: () => {
      calls.push("destroySource");
    },
    destroyResponse: () => {
      calls.push("destroyResponse");
    }
  };
}

describe("download transfer boundary (finish-before-end race)", () => {
  it("finish consumes synchronously even when it fires before the stream end", () => {
    const sink = recordingSink();
    const tracker = createDownloadTracker(sink);
    // The reported race order: response flushes fully, `finish` fires, the
    // readable stream has not emitted `end` yet, then `close` follows.
    tracker.onFinish();
    tracker.onClose();
    expect(sink.calls).toEqual(["consumeSync"]);
  });

  it("close observing writableFinished consumes before the finish callback runs", () => {
    const sink = recordingSink();
    const tracker = createDownloadTracker(sink);
    // Exact U6G race order on a short non-keepalive connection: the server
    // `close` handler runs while `res.writableFinished === true` but before
    // the registered `finish` callback has executed.
    tracker.onClose(true);
    expect(sink.calls).toEqual(["consumeSync"]);
    // The late `finish` and any trailing `close` must not double-settle,
    // so a replay can never lease the consumed record.
    tracker.onFinish();
    tracker.onClose(true);
    tracker.onClose(false);
    expect(sink.calls).toEqual(["consumeSync"]);
  });

  it("close with writableFinished false still releases the lease", () => {
    const sink = recordingSink();
    const tracker = createDownloadTracker(sink);
    tracker.onClose(false);
    expect(sink.calls).toEqual(["destroySource", "release"]);
  });

  it("repeated finish/close events consume exactly once", () => {
    const sink = recordingSink();
    const tracker = createDownloadTracker(sink);
    tracker.onFinish();
    tracker.onFinish();
    tracker.onClose();
    tracker.onClose();
    expect(sink.calls).toEqual(["consumeSync"]);
  });

  it("close before finish releases the lease for one retry", () => {
    const sink = recordingSink();
    const tracker = createDownloadTracker(sink);
    tracker.onClose();
    expect(sink.calls).toEqual(["destroySource", "release"]);
    // A late finish must not resurrect or double-settle the transfer.
    tracker.onFinish();
    tracker.onClose();
    expect(sink.calls).toEqual(["destroySource", "release"]);
  });

  it("request abort releases the lease", () => {
    const sink = recordingSink();
    const tracker = createDownloadTracker(sink);
    tracker.onAbort();
    expect(sink.calls).toEqual(["destroySource", "release"]);
  });

  it("stream error destroys the response and releases the lease", () => {
    const sink = recordingSink();
    const tracker = createDownloadTracker(sink);
    tracker.onStreamError();
    expect(sink.calls).toEqual(["destroyResponse", "release"]);
  });

  it("abort after finish cannot release a consumed record", () => {
    const sink = recordingSink();
    const tracker = createDownloadTracker(sink);
    tracker.onFinish();
    tracker.onAbort();
    tracker.onStreamError();
    expect(sink.calls).toEqual(["consumeSync"]);
  });
});
