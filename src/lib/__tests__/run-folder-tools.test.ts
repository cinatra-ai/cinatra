/**
 * cinatra#3030 (epic #3023, lifecycle-c W6) — THE RUN FOLDER'S HOST FILE TOOLS
 * (plan item 0.21): "an agent writes to it through host file tools on the
 * passthrough (write, list, read, confined to the run's folder)".
 *
 * The scope is the point. Every one of the three takes its organisation and run
 * from the caller — which, on the passthrough, is the run the REQUEST ITSELF
 * PROVED — so a tool call can never name a folder of its own choosing, and the
 * confinement, the symlink refusal and both caps come back as stated reasons a
 * calling node fails visibly on. Real disk; the folder has no table.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("@/lib/database", () => ({
  readMetadataValueFromDatabase: (_key: string, fallback: unknown) => fallback,
  writeMetadataValueToDatabase: () => {},
}));

let ROOT = "";
let tools: typeof import("@/lib/run-folder-tools");
let folder: typeof import("@/lib/artifacts/run-folder");

const ORG = "org-3030t";
const RUN = "run-3030t";
const OTHER_RUN = "run-3030-other";

beforeAll(async () => {
  ROOT = await fsp.mkdtemp(path.join(os.tmpdir(), "cinatra-run-tools-"));
  process.env.CINATRA_RUN_DATA_ROOT = ROOT;
  tools = await import("@/lib/run-folder-tools");
  folder = await import("@/lib/artifacts/run-folder");
});

afterEach(async () => {
  await fsp.rm(path.join(ROOT, ORG), { recursive: true, force: true });
});

afterAll(async () => {
  delete process.env.CINATRA_RUN_DATA_ROOT;
  await fsp.rm(ROOT, { recursive: true, force: true });
});

const call = (tool: string, raw: Record<string, unknown>, runId = RUN) =>
  tools.dispatchRunFolderTool({ tool, orgId: ORG, runId, raw });

describe("item 0.21 — write, list, read", () => {
  it("writes a file, lists it, and reads it back", async () => {
    const written = await call(tools.RUN_FOLDER_WRITE_TOOL, {
      path: "notes/report.md",
      content: "# Report\n",
    });
    expect(written.ok).toBe(true);
    if (written.ok) {
      expect(written.result.relPath).toBe("notes/report.md");
      expect(written.result.byteLength).toBe(9);
    }

    const listed = await call(tools.RUN_FOLDER_LIST_TOOL, {});
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.result.files).toEqual([{ path: "notes/report.md", byteLength: 9 }]);
    }

    const read = await call(tools.RUN_FOLDER_READ_TOOL, { path: "notes/report.md" });
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.result.content).toBe("# Report\n");
  });

  it("carries bytes as base64 in both directions when the caller says so", async () => {
    const payload = Buffer.from([0x00, 0x01, 0x02, 0xff]);
    const written = await call(tools.RUN_FOLDER_WRITE_TOOL, {
      path: "blob.bin",
      content: payload.toString("base64"),
      encoding: "base64",
    });
    expect(written.ok).toBe(true);
    const read = await call(tools.RUN_FOLDER_READ_TOOL, { path: "blob.bin", encoding: "base64" });
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(Buffer.from(String(read.result.content), "base64").equals(payload)).toBe(true);
    }
  });

  it("never hands an absolute path back to the caller", async () => {
    await call(tools.RUN_FOLDER_WRITE_TOOL, { path: "a.md", content: "x" });
    const listed = await call(tools.RUN_FOLDER_LIST_TOOL, {});
    expect(JSON.stringify(listed)).not.toContain(ROOT);
  });
});

describe("item 0.21 — the scope is the caller's run, and nothing else", () => {
  it("cannot see another run's folder", async () => {
    await folder.writeRunOutputFile({
      orgId: ORG,
      runId: OTHER_RUN,
      relPath: "secret.md",
      bytes: new TextEncoder().encode("not yours"),
    });
    const listed = await call(tools.RUN_FOLDER_LIST_TOOL, {});
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.result.files).toEqual([]);
    const read = await call(tools.RUN_FOLDER_READ_TOOL, { path: "secret.md" });
    expect(read).toMatchObject({ ok: false, reason: "not_found" });
  });

  it("refuses a path that leaves the outputs folder", async () => {
    const out = await call(tools.RUN_FOLDER_WRITE_TOOL, {
      path: "../../escape.md",
      content: "x",
    });
    expect(out).toMatchObject({ ok: false, reason: "path_escape" });
  });

  it("refuses an unknown tool rather than guessing", async () => {
    const out = await call("run_folder_delete", { path: "a.md" });
    expect(out).toMatchObject({ ok: false, reason: "unknown_tool" });
  });

  it("refuses a write with no usable path or content, with a stated reason", async () => {
    expect(await call(tools.RUN_FOLDER_WRITE_TOOL, { content: "x" })).toMatchObject({
      ok: false,
      reason: "invalid_path",
    });
    expect(await call(tools.RUN_FOLDER_WRITE_TOOL, { path: "a.md" })).toMatchObject({
      ok: false,
      reason: "invalid_path",
    });
    expect(
      await call(tools.RUN_FOLDER_WRITE_TOOL, { path: "a.md", content: "x", encoding: "latin1" }),
    ).toMatchObject({ ok: false, reason: "invalid_path" });
  });

  it("names all three tools, and only those three", () => {
    expect([...tools.RUN_FOLDER_TOOLS].sort()).toEqual([
      "run_folder_list",
      "run_folder_read",
      "run_folder_write",
    ]);
  });
});
