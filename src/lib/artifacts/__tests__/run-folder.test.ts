/**
 * cinatra#3030 (epic #3023 W6) — THE RUN FOLDER, as item 0.21 describes it.
 *
 * Plan sentence (item 0.21, in full):
 *
 *   "The run folder: `data/agents/runs/<organisation>/<run>/` under the same data
 *    root as the artifact store — resolved like the artifact root (environment,
 *    then the stored setting, then the default), guarded at boot, path-confined
 *    with symlinks refused, and placed where the artifact store is placed: one
 *    root per deployment, on shared storage where the application runs on more
 *    than one host — with an `outputs` folder inside it that is the only place
 *    the pickup reads. [...] A per-file cap equal to the upload cap, a per-run
 *    cap, and a retention tier of its own [...]"
 *
 * Every rule that sentence states is a case here: the resolution order, the
 * confinement, the symlink refusal, the two caps, and "the outputs folder is the
 * only place the pickup reads".
 */
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_RUN_DATA_ROOT,
  RUN_DATA_ROOT_ENV,
  readRunDataRoot,
  resolveRunDataRoot,
} from "../run-data-root";
import {
  RUN_FOLDER_FILE_CAP_BYTES,
  RUN_FOLDER_FILE_CAP_ENV,
  RUN_FOLDER_RUN_CAP_ENV,
  RunFolderRefusal,
  decodeUtf8Exact,
  listRunOutputFiles,
  markRunFolderPickedUp,
  readRunFolderPickup,
  readRunOutputFile,
  resolveRunOutputPath,
  runFolderPath,
  runOutputsPath,
  writeRunOutputFile,
} from "../run-folder";

const ORG = "org-3030";
const RUN = "run-3030";
let root = "";

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "cin-runfolder-"));
  process.env[RUN_DATA_ROOT_ENV] = root;
  delete process.env[RUN_FOLDER_FILE_CAP_ENV];
  delete process.env[RUN_FOLDER_RUN_CAP_ENV];
});

afterEach(() => {
  delete process.env[RUN_DATA_ROOT_ENV];
  delete process.env[RUN_FOLDER_FILE_CAP_ENV];
  delete process.env[RUN_FOLDER_RUN_CAP_ENV];
  rmSync(root, { recursive: true, force: true });
});

describe("the root resolves like the artifact root", () => {
  it("takes the environment first", () => {
    expect(readRunDataRoot()).toBe(root);
    expect(resolveRunDataRoot()).toBe(path.resolve(root));
  });

  it("falls back to the default when the environment is unset", () => {
    delete process.env[RUN_DATA_ROOT_ENV];
    expect(readRunDataRoot()).toBe(DEFAULT_RUN_DATA_ROOT);
    expect(DEFAULT_RUN_DATA_ROOT).toBe(path.join("data", "agents", "runs"));
  });

  it("places the folder at <root>/<organisation>/<run>, outputs inside it", () => {
    expect(runFolderPath(ORG, RUN)).toBe(path.join(path.resolve(root), ORG, RUN));
    expect(runOutputsPath(ORG, RUN)).toBe(path.join(path.resolve(root), ORG, RUN, "outputs"));
  });
});

describe("the tools write, list and read — confined to the run's folder", () => {
  it("writes a file and reads it back", async () => {
    const written = await writeRunOutputFile({
      orgId: ORG,
      runId: RUN,
      relPath: "draft.md",
      bytes: new TextEncoder().encode("# a draft\n"),
    });
    expect(written).toMatchObject({ relPath: "draft.md", byteLength: 10 });
    const read = await readRunOutputFile({ orgId: ORG, runId: RUN, relPath: "draft.md" });
    expect(read.bytes.toString("utf8")).toBe("# a draft\n");
  });

  it("lists every file under outputs, deepest paths included, in a stable order", async () => {
    for (const rel of ["b.txt", "nested/deep/a.txt", "a.txt"]) {
      await writeRunOutputFile({
        orgId: ORG,
        runId: RUN,
        relPath: rel,
        bytes: new TextEncoder().encode(rel),
      });
    }
    const files = await listRunOutputFiles({ orgId: ORG, runId: RUN });
    expect(files.map((f) => f.relPath)).toEqual(["a.txt", "b.txt", "nested/deep/a.txt"]);
  });

  it("the outputs folder is the ONLY place the pickup reads", async () => {
    mkdirSync(runFolderPath(ORG, RUN), { recursive: true });
    writeFileSync(path.join(runFolderPath(ORG, RUN), "beside.txt"), "not an output");
    await writeRunOutputFile({
      orgId: ORG,
      runId: RUN,
      relPath: "inside.txt",
      bytes: new TextEncoder().encode("an output"),
    });
    const files = await listRunOutputFiles({ orgId: ORG, runId: RUN });
    expect(files.map((f) => f.relPath)).toEqual(["inside.txt"]);
  });

  it("refuses a path that leaves the folder", async () => {
    await expect(
      resolveRunOutputPath({ orgId: ORG, runId: RUN, relPath: "../../escape.txt" }),
    ).rejects.toMatchObject({ reason: "path_escape" });
    await expect(
      resolveRunOutputPath({ orgId: ORG, runId: RUN, relPath: "/etc/passwd" }),
    ).rejects.toMatchObject({ reason: "invalid_path" });
  });

  it("refuses a run or organisation id that is not a plain identifier", async () => {
    await expect(
      resolveRunOutputPath({ orgId: "../other", runId: RUN, relPath: "a.txt" }),
    ).rejects.toBeInstanceOf(RunFolderRefusal);
  });

  it("REFUSES a symlink rather than following it", async () => {
    const outside = path.join(root, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, "secret.txt"), "not the run's");
    const outputs = runOutputsPath(ORG, RUN);
    mkdirSync(outputs, { recursive: true });
    symlinkSync(outside, path.join(outputs, "link"));
    await expect(
      resolveRunOutputPath({ orgId: ORG, runId: RUN, relPath: "link/secret.txt" }),
    ).rejects.toMatchObject({ reason: "symlink" });
    // And a link is not a file the pickup reads.
    symlinkSync(path.join(outside, "secret.txt"), path.join(outputs, "linked.txt"));
    const files = await listRunOutputFiles({ orgId: ORG, runId: RUN });
    expect(files).toEqual([]);
  });
});

describe("the caps", () => {
  it("the per-file cap equals the upload cap", () => {
    expect(RUN_FOLDER_FILE_CAP_BYTES).toBe(50 * 1024 * 1024);
  });

  it("refuses a file over the per-file cap", async () => {
    process.env[RUN_FOLDER_FILE_CAP_ENV] = "16";
    await expect(
      writeRunOutputFile({
        orgId: ORG,
        runId: RUN,
        relPath: "big.bin",
        bytes: new Uint8Array(17),
      }),
    ).rejects.toMatchObject({ reason: "file_cap" });
  });

  it("refuses a write that would put the run over the per-run cap", async () => {
    process.env[RUN_FOLDER_RUN_CAP_ENV] = "24";
    await writeRunOutputFile({
      orgId: ORG,
      runId: RUN,
      relPath: "one.bin",
      bytes: new Uint8Array(16),
    });
    await expect(
      writeRunOutputFile({
        orgId: ORG,
        runId: RUN,
        relPath: "two.bin",
        bytes: new Uint8Array(16),
      }),
    ).rejects.toMatchObject({ reason: "run_cap" });
    // Overwriting the SAME file does not double-count its bytes.
    await expect(
      writeRunOutputFile({
        orgId: ORG,
        runId: RUN,
        relPath: "one.bin",
        bytes: new Uint8Array(20),
      }),
    ).resolves.toMatchObject({ byteLength: 20 });
  });
});

describe("the pickup receipt", () => {
  it("records the instant the pickup read the folder, outside outputs", async () => {
    const at = new Date("2026-01-02T03:04:05.000Z");
    await markRunFolderPickedUp({ orgId: ORG, runId: RUN, at, files: 2 });
    const receipt = await readRunFolderPickup(runFolderPath(ORG, RUN));
    expect(receipt).toEqual({ pickedUpAt: at.toISOString(), files: 2 });
    const files = await listRunOutputFiles({ orgId: ORG, runId: RUN });
    expect(files).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The convergence round's adopted findings.
// ---------------------------------------------------------------------------

describe("bytes that are not text", () => {
  it("are told apart from text, rather than transcoded into it", () => {
    expect(decodeUtf8Exact(Buffer.from("a draft an agent wrote\n", "utf8"))).toBe(
      "a draft an agent wrote\n",
    );
    // Multi-byte text survives the round trip unchanged.
    expect(decodeUtf8Exact(Buffer.from("ein Entwurf — mit Gedankenstrich", "utf8"))).toBe(
      "ein Entwurf — mit Gedankenstrich",
    );
    // A PNG's magic number is not UTF-8, and `toString("utf8")` would happily
    // hand back a lossy string of U+FFFD instead of saying so.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.toString("utf8")).not.toBe("");
    expect(decodeUtf8Exact(png)).toBeNull();
    // A lone continuation byte is the smallest case that must be refused.
    expect(decodeUtf8Exact(Buffer.from([0x80]))).toBeNull();
    // A TRUNCATED multi-byte sequence is refused too.
    expect(decodeUtf8Exact(Buffer.from("é", "utf8").subarray(0, 1))).toBeNull();
  });
});

describe("a link at the file itself", () => {
  it("is refused by the write and by the read, and is never opened through", async () => {
    const outputs = runOutputsPath(ORG, RUN);
    mkdirSync(outputs, { recursive: true });
    const outside = path.join(root, "outside.txt");
    writeFileSync(outside, "not this run's bytes\n", "utf8");
    symlinkSync(outside, path.join(outputs, "linked.txt"));

    await expect(
      writeRunOutputFile({
        orgId: ORG,
        runId: RUN,
        relPath: "linked.txt",
        bytes: Buffer.from("through the link\n", "utf8"),
      }),
    ).rejects.toMatchObject({ reason: "symlink" });

    await expect(
      readRunOutputFile({ orgId: ORG, runId: RUN, relPath: "linked.txt" }),
    ).rejects.toMatchObject({ reason: "symlink" });

    // The bytes outside the folder are untouched: the link was refused, never
    // followed.
    expect(readFileSync(outside, "utf8")).toBe("not this run's bytes\n");
  });
});
