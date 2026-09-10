/**
 * cinatra#3030 (epic #3023, lifecycle-c W6) — THE SANDBOX PUBLISH (plan item
 * 0.21): "a sandbox publishes a file from its own workspace into the folder
 * through one tool that copies it across the broker".
 *
 * What these prove is that the publish is NOT a new authorization path: it is
 * one ordinary command on the existing audited channel, so the command text the
 * voucher signs is fixed and knowable, an unpublishable path never becomes a
 * command at all, and the advertised cap is the cap that actually binds.
 */
import { describe, expect, it } from "vitest";
import {
  ExecutionBroker,
  PUBLISH_FILE_MAX_BYTES,
  publishFileMaxBytes,
  validatePublishPath,
  type PublishFileResult,
} from "../broker";
import { DEFAULT_SANDBOX_LIMITS } from "../types";

/** A broker whose ONLY behaviour is the `exec` answer under test — the publish
 *  is a thin wrapper over that verb, and this is the seam it wraps. */
function brokerWith(
  exec: (jobId: string, command: string, voucher: string) => Promise<unknown>,
  maxStdioBytes = DEFAULT_SANDBOX_LIMITS.maxStdioBytes,
): {
  publishFile: (j: string, p: string, v: string) => Promise<PublishFileResult>;
  commands: string[];
} {
  const commands: string[] = [];
  const self = Object.create(ExecutionBroker.prototype) as Record<string, unknown> & {
    publishFile: (j: string, p: string, v: string) => Promise<PublishFileResult>;
  };
  self.limits = { ...DEFAULT_SANDBOX_LIMITS, maxStdioBytes };
  self.exec = async (jobId: string, command: string, voucher: string) => {
    commands.push(command);
    return exec(jobId, command, voucher);
  };
  return { publishFile: (j, p, v) => self.publishFile(j, p, v), commands };
}

const ok = (stdout: string, extra: Record<string, unknown> = {}) => ({
  ok: true as const,
  result: { stdout, stderr: "", exitCode: 0, stdoutTruncated: false, ...extra },
});

describe("item 0.21 — the path is validated on the HOST, before any command text exists", () => {
  it("accepts a plain workspace-relative path", () => {
    expect(validatePublishPath("out/report.md")).toBeNull();
    expect(validatePublishPath("report.md")).toBeNull();
  });

  it("refuses an absolute path — a sandbox has no host path to publish from", () => {
    expect(validatePublishPath("/etc/passwd")).toMatch(/workspace-relative/);
  });

  it("refuses a parent segment", () => {
    expect(validatePublishPath("../outside.md")).toMatch(/may not leave the workspace/);
    expect(validatePublishPath("a/../../b.md")).toMatch(/may not leave the workspace/);
  });

  it("refuses every shell metacharacter — one signed command means one thing", () => {
    for (const bad of [
      "report.md; rm -rf /",
      "report.md && echo x",
      "$(whoami).md",
      "`id`.md",
      "a|b.md",
      "a b.md",
      "a\nb.md",
      "a'b.md",
      'a"b.md',
      "a*.md",
    ]) {
      expect(validatePublishPath(bad)).toMatch(/may contain only letters/);
    }
  });

  it("refuses an empty path", () => {
    expect(validatePublishPath("")).toMatch(/non-empty/);
    expect(validatePublishPath("   ")).toMatch(/non-empty/);
  });
});

describe("item 0.21 — the command the voucher signs", () => {
  it("is one fixed, knowable text", () => {
    expect(ExecutionBroker.publishFileCommand("out/report.md")).toBe(
      "base64 -w 0 -- out/report.md",
    );
  });
});

describe("item 0.21 — the cap is the CHANNEL's, so the refusal and the advertised number agree", () => {
  it("derives from the stdio limit at three bytes of file per four of stdout", () => {
    expect(publishFileMaxBytes(4000)).toBe(3000);
    expect(publishFileMaxBytes(4001)).toBe(3000);
    expect(PUBLISH_FILE_MAX_BYTES).toBe(
      publishFileMaxBytes(DEFAULT_SANDBOX_LIMITS.maxStdioBytes),
    );
  });
});

describe("item 0.21 — the publish rides the exec verb and never around it", () => {
  it("returns the file's bytes, size and digest", async () => {
    const payload = Buffer.from("# Report\n", "utf8");
    const { publishFile, commands } = brokerWith(async () =>
      ok(payload.toString("base64")),
    );
    const out = await publishFile("job-1", "out/report.md", "voucher");
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(Buffer.from(out.bytesBase64, "base64").toString("utf8")).toBe("# Report\n");
      expect(out.byteLength).toBe(payload.byteLength);
      expect(out.path).toBe("out/report.md");
      expect(out.sha256).toHaveLength(64);
    }
    expect(commands).toEqual(["base64 -w 0 -- out/report.md"]);
  });

  it("never asks the sandbox anything when the path is unpublishable", async () => {
    const { publishFile, commands } = brokerWith(async () => ok(""));
    const out = await publishFile("job-1", "../escape.md", "voucher");
    expect(out).toMatchObject({ ok: false, reason: "invalid_path" });
    expect(commands).toEqual([]);
  });

  it("passes an exec refusal through as a refusal", async () => {
    const { publishFile } = brokerWith(async () => ({
      ok: false as const,
      reason: "voucher_mismatch",
      message: "the voucher does not bind this command",
    }));
    const out = await publishFile("job-1", "out/report.md", "wrong");
    expect(out).toMatchObject({ ok: false, reason: "refused" });
    if (!out.ok) expect(out.message).toMatch(/voucher/);
  });

  it("refuses a truncated answer — half a file is not a file", async () => {
    const { publishFile } = brokerWith(async () =>
      ok(Buffer.from("partial", "utf8").toString("base64"), { stdoutTruncated: true }),
    );
    const out = await publishFile("job-1", "out/big.md", "voucher");
    expect(out).toMatchObject({ ok: false, reason: "too_large" });
  });

  it("refuses a file the sandbox could not read", async () => {
    const { publishFile } = brokerWith(async () => ({
      ok: true as const,
      result: {
        stdout: "",
        stderr: "base64: out/missing.md: No such file or directory",
        exitCode: 1,
        stdoutTruncated: false,
      },
    }));
    const out = await publishFile("job-1", "out/missing.md", "voucher");
    expect(out).toMatchObject({ ok: false, reason: "not_readable" });
    if (!out.ok) expect(out.message).toMatch(/No such file/);
  });

  it("refuses a file over the derived cap", async () => {
    const payload = Buffer.alloc(40, 0x61);
    const { publishFile } = brokerWith(async () => ok(payload.toString("base64")), 40);
    const out = await publishFile("job-1", "out/big.md", "voucher");
    expect(out).toMatchObject({ ok: false, reason: "too_large" });
    if (!out.ok) expect(out.message).toMatch(/publish cap is 30 bytes/);
  });
});
