/**
 * cinatra#3030 (epic #3023, lifecycle-c W6) — THE RUN FOLDER itself (plan item
 * 0.21): the confinement rule, the symlink refusal, the two caps, the listing
 * the pickup reads, the honest UTF-8 test and the pickup receipt.
 *
 * Real disk, no database: the folder "has no table" (plan §8.2), so everything
 * this module promises is a fact about a filesystem and is proved on one.
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
let folder: typeof import("@/lib/artifacts/run-folder");

const ORG = "org-3030";
const RUN = "run-3030";

beforeAll(async () => {
  ROOT = await fsp.mkdtemp(path.join(os.tmpdir(), "cinatra-run-folder-"));
  process.env.CINATRA_RUN_DATA_ROOT = ROOT;
  folder = await import("@/lib/artifacts/run-folder");
});

afterEach(async () => {
  await fsp.rm(path.join(ROOT, ORG), { recursive: true, force: true });
  delete process.env.CINATRA_RUN_FOLDER_FILE_CAP_BYTES;
  delete process.env.CINATRA_RUN_FOLDER_RUN_CAP_BYTES;
});

afterAll(async () => {
  delete process.env.CINATRA_RUN_DATA_ROOT;
  await fsp.rm(ROOT, { recursive: true, force: true });
});

describe("item 0.21 — the run folder's shape", () => {
  it("puts a run's outputs at <root>/<organisation>/<run>/outputs", () => {
    expect(folder.runOutputsPath(ORG, RUN)).toBe(path.join(ROOT, ORG, RUN, "outputs"));
  });

  it("refuses an organisation or run id that is not a plain identifier", () => {
    expect(() => folder.runOutputsPath("../escape", RUN)).toThrow(/not a plain identifier/);
    expect(() => folder.runOutputsPath(ORG, "run/../..")).toThrow(/not a plain identifier/);
  });
});

describe("item 0.21 — confinement, and the symlink refusal on top of it", () => {
  it("writes and reads a file back under its own relative path", async () => {
    const written = await folder.writeRunOutputFile({
      orgId: ORG,
      runId: RUN,
      relPath: "notes/report.md",
      bytes: new TextEncoder().encode("# Report\n"),
    });
    expect(written.relPath).toBe("notes/report.md");
    const read = await folder.readRunOutputFile({ orgId: ORG, runId: RUN, relPath: "notes/report.md" });
    expect(read.bytes.toString("utf8")).toBe("# Report\n");
  });

  it("refuses a path that leaves the outputs folder", async () => {
    await expect(
      folder.writeRunOutputFile({
        orgId: ORG,
        runId: RUN,
        relPath: "../../elsewhere.md",
        bytes: new TextEncoder().encode("x"),
      }),
    ).rejects.toMatchObject({ reason: "path_escape" });
  });

  it("refuses an absolute path", async () => {
    await expect(
      folder.writeRunOutputFile({
        orgId: ORG,
        runId: RUN,
        relPath: path.join(ROOT, "absolute.md"),
        bytes: new TextEncoder().encode("x"),
      }),
    ).rejects.toMatchObject({ reason: "invalid_path" });
  });

  it("refuses a symbolic link ON the path rather than following it", async () => {
    const outputs = folder.runOutputsPath(ORG, RUN);
    await fsp.mkdir(outputs, { recursive: true });
    const outside = path.join(ROOT, "outside");
    await fsp.mkdir(outside, { recursive: true });
    await fsp.symlink(outside, path.join(outputs, "linked"));
    await expect(
      folder.writeRunOutputFile({
        orgId: ORG,
        runId: RUN,
        relPath: "linked/escaped.md",
        bytes: new TextEncoder().encode("x"),
      }),
    ).rejects.toMatchObject({ reason: "symlink" });
    await expect(fsp.readdir(outside)).resolves.toEqual([]);
  });

  it("refuses to read through a symbolic link that names a file outside the folder", async () => {
    const outputs = folder.runOutputsPath(ORG, RUN);
    await fsp.mkdir(outputs, { recursive: true });
    const secret = path.join(ROOT, "secret.txt");
    await fsp.writeFile(secret, "not yours");
    await fsp.symlink(secret, path.join(outputs, "peek.txt"));
    await expect(
      folder.readRunOutputFile({ orgId: ORG, runId: RUN, relPath: "peek.txt" }),
    ).rejects.toMatchObject({ reason: "symlink" });
  });
});

describe("item 0.21 — the caps", () => {
  it("refuses a file over the per-file cap", async () => {
    process.env.CINATRA_RUN_FOLDER_FILE_CAP_BYTES = "8";
    await expect(
      folder.writeRunOutputFile({
        orgId: ORG,
        runId: RUN,
        relPath: "big.md",
        bytes: new TextEncoder().encode("far too many bytes"),
      }),
    ).rejects.toMatchObject({ reason: "file_cap" });
  });

  it("refuses the write that would put the run over the per-run cap", async () => {
    process.env.CINATRA_RUN_FOLDER_RUN_CAP_BYTES = "12";
    await folder.writeRunOutputFile({
      orgId: ORG,
      runId: RUN,
      relPath: "a.md",
      bytes: new TextEncoder().encode("0123456789"),
    });
    await expect(
      folder.writeRunOutputFile({
        orgId: ORG,
        runId: RUN,
        relPath: "b.md",
        bytes: new TextEncoder().encode("0123456789"),
      }),
    ).rejects.toMatchObject({ reason: "run_cap" });
  });
});

describe("item 0.22 — what the pickup reads", () => {
  it("lists every file under outputs, deepest paths included, in a stable order", async () => {
    for (const rel of ["b.md", "nested/deep/a.md", "a.md"]) {
      await folder.writeRunOutputFile({
        orgId: ORG,
        runId: RUN,
        relPath: rel,
        bytes: new TextEncoder().encode(rel),
      });
    }
    const files = await folder.listRunOutputFiles({ orgId: ORG, runId: RUN });
    expect(files.map((f) => f.relPath)).toEqual(["a.md", "b.md", "nested/deep/a.md"]);
  });

  it("does not list a symbolic link as a file", async () => {
    const outputs = folder.runOutputsPath(ORG, RUN);
    await fsp.mkdir(outputs, { recursive: true });
    await fsp.writeFile(path.join(ROOT, "elsewhere.md"), "x");
    await fsp.symlink(path.join(ROOT, "elsewhere.md"), path.join(outputs, "link.md"));
    const files = await folder.listRunOutputFiles({ orgId: ORG, runId: RUN });
    expect(files).toEqual([]);
  });

  it("decodes UTF-8 exactly and refuses bytes that are not UTF-8 text", () => {
    expect(folder.decodeUtf8Exact(Buffer.from("héllo", "utf8"))).toBe("héllo");
    // A PNG's own signature: valid bytes, not text. `toString("utf8")` would
    // substitute U+FFFD and never fail, which is the corruption this refuses.
    expect(folder.decodeUtf8Exact(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]))).toBeNull();
  });
});

describe("item 0.21 — the pickup receipt", () => {
  it("writes the receipt into the RUN folder, never into outputs", async () => {
    const at = new Date("2026-01-01T00:00:00.000Z");
    await folder.markRunFolderPickedUp({ orgId: ORG, runId: RUN, at, files: 3 });
    const receipt = await folder.readRunFolderPickup(folder.runFolderPath(ORG, RUN));
    expect(receipt).toEqual({ pickedUpAt: at.toISOString(), files: 3 });
    const outputs = await folder.listRunOutputFiles({ orgId: ORG, runId: RUN });
    expect(outputs).toEqual([]);
  });

  it("reads null for a folder no pickup has reached", async () => {
    await fsp.mkdir(folder.runFolderPath(ORG, RUN), { recursive: true });
    expect(await folder.readRunFolderPickup(folder.runFolderPath(ORG, RUN))).toBeNull();
  });
});

describe("the symlink refusal covers the folder's ANCESTORS (convergence round)", () => {
  it("refuses to read, write or list through a run directory that is a link to another run", async () => {
    // The victim: a real run folder with a real file in it.
    await folder.writeRunOutputFile({
      orgId: ORG,
      runId: "run-victim",
      relPath: "secret.md",
      bytes: new TextEncoder().encode("# The other run's file\n"),
    });
    // The attacker's run directory IS a link to the victim's.
    await fsp.mkdir(path.join(ROOT, ORG), { recursive: true });
    await fsp.symlink(
      path.join(ROOT, ORG, "run-victim"),
      path.join(ROOT, ORG, "run-thief"),
      "dir",
    );

    await expect(
      folder.readRunOutputFile({ orgId: ORG, runId: "run-thief", relPath: "secret.md" }),
    ).rejects.toMatchObject({ reason: "symlink" });
    await expect(
      folder.writeRunOutputFile({
        orgId: ORG,
        runId: "run-thief",
        relPath: "planted.md",
        bytes: new TextEncoder().encode("# planted\n"),
      }),
    ).rejects.toMatchObject({ reason: "symlink" });
    await expect(
      folder.listRunOutputFiles({ orgId: ORG, runId: "run-thief" }),
    ).rejects.toMatchObject({ reason: "symlink" });

    // The victim's own folder is untouched by the refusals.
    const victim = await folder.listRunOutputFiles({ orgId: ORG, runId: "run-victim" });
    expect(victim.map((f) => f.relPath)).toEqual(["secret.md"]);

    await fsp.rm(path.join(ROOT, ORG, "run-thief"), { force: true });
    await fsp.rm(path.join(ROOT, ORG, "run-victim"), { recursive: true, force: true });
  });

  it("refuses when the ORGANISATION directory is a link", async () => {
    await fsp.mkdir(path.join(ROOT, "org-real", RUN, "outputs"), { recursive: true });
    await fsp.symlink(path.join(ROOT, "org-real"), path.join(ROOT, "org-link"), "dir");
    await expect(
      folder.listRunOutputFiles({ orgId: "org-link", runId: RUN }),
    ).rejects.toMatchObject({ reason: "symlink" });
    await fsp.rm(path.join(ROOT, "org-link"), { force: true });
    await fsp.rm(path.join(ROOT, "org-real"), { recursive: true, force: true });
  });
});

describe("the ONE path gate every filesystem call in the module goes through", () => {
  const enc = (text: string) => new TextEncoder().encode(text);
  const outputsRoot = () => path.join(ROOT, ORG, RUN, "outputs");

  it("the O_NOFOLLOW open takes its path from the gate: an encoded traversal is refused, a plain identifier is accepted, and the name opened stays inside the root", async () => {
    await folder.writeRunOutputFile({
      orgId: ORG,
      runId: RUN,
      relPath: "report.md",
      bytes: enc("# Report\n"),
    });
    const read = await folder.readRunOutputFile({ orgId: ORG, runId: RUN, relPath: "report.md" });
    expect(read.bytes.toString("utf8")).toBe("# Report\n");

    // CONTAINMENT: the name the open is handed resolves inside the run data root.
    const resolved = await folder.resolveRunOutputPath({
      orgId: ORG,
      runId: RUN,
      relPath: "report.md",
    });
    expect(path.relative(ROOT, resolved.abs).startsWith("..")).toBe(false);
    expect(resolved.abs.startsWith(ROOT + path.sep)).toBe(true);

    // A traversal that hides behind an encoding is not a plain identifier, so it
    // never reaches the open.
    await expect(
      folder.readRunOutputFile({ orgId: ORG, runId: RUN, relPath: "..%2f..%2fescape.md" }),
    ).rejects.toMatchObject({ reason: "invalid_path" });
  });

  it("the existing-size stat takes its path from the gate: an encoded traversal is refused, an overwrite of a plain identifier is accepted, and the file measured stays inside the outputs folder", async () => {
    process.env.CINATRA_RUN_FOLDER_RUN_CAP_BYTES = "12";
    await folder.writeRunOutputFile({
      orgId: ORG,
      runId: RUN,
      relPath: "a.md",
      bytes: enc("0123456789"),
    });
    // The overwrite only fits under the per-run cap because the stat found the
    // ten bytes already there — the site is really exercised.
    const again = await folder.writeRunOutputFile({
      orgId: ORG,
      runId: RUN,
      relPath: "a.md",
      bytes: enc("9876543210"),
    });
    expect(again.relPath).toBe("a.md");

    // CONTAINMENT: the file measured is the one inside this run's outputs folder.
    const files = await folder.listRunOutputFiles({ orgId: ORG, runId: RUN });
    expect(files.map((f) => f.relPath)).toEqual(["a.md"]);
    expect(files[0].absPath.startsWith(outputsRoot() + path.sep)).toBe(true);
    expect(path.relative(ROOT, files[0].absPath).startsWith("..")).toBe(false);

    await expect(
      folder.writeRunOutputFile({
        orgId: ORG,
        runId: RUN,
        relPath: "a%2e%2e%2fescape.md",
        bytes: enc("x"),
      }),
    ).rejects.toMatchObject({ reason: "invalid_path" });
  });

  it("the parent mkdir takes its path from the gate: an encoded traversal is refused and creates nothing, a nested plain identifier is accepted, and the directory made stays inside the outputs folder", async () => {
    const written = await folder.writeRunOutputFile({
      orgId: ORG,
      runId: RUN,
      relPath: "nested/deep/report.md",
      bytes: enc("x"),
    });
    expect(written.relPath).toBe("nested/deep/report.md");

    // CONTAINMENT: the directory the mkdir made is inside this run's outputs folder.
    const made = path.join(outputsRoot(), "nested", "deep");
    expect((await fsp.stat(made)).isDirectory()).toBe(true);
    expect(path.relative(outputsRoot(), made).startsWith("..")).toBe(false);

    await expect(
      folder.writeRunOutputFile({
        orgId: ORG,
        runId: RUN,
        relPath: "nested%2f..%2fescape/report.md",
        bytes: enc("x"),
      }),
    ).rejects.toMatchObject({ reason: "invalid_path" });
    await expect(fsp.stat(path.join(outputsRoot(), "nested%2f..%2fescape"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("the gate refuses the caller's OWN components, before normalization (convergence round)", () => {
  const enc = (text: string) => new TextEncoder().encode(text);

  it.each([
    ["a name that normalization would make disappear", "bad name/../report.md"],
    ["a doubled separator", "nested//report.md"],
    ["a same-folder component", "nested/./report.md"],
    ["a trailing separator", "report.md/"],
    ["a backslash-rooted name", "\\outside\\report.md"],
  ])("refuses %s and writes nothing", async (_what, relPath) => {
    await expect(
      folder.writeRunOutputFile({ orgId: ORG, runId: RUN, relPath, bytes: enc("x") }),
    ).rejects.toMatchObject({ reason: expect.stringMatching(/^(invalid_path|path_escape)$/) });
    const files = await folder.listRunOutputFiles({ orgId: ORG, runId: RUN });
    expect(files).toEqual([]);
  });

  it("still calls a climbing path an escape, and still accepts a plain nested identifier", async () => {
    await expect(
      folder.readRunOutputFile({ orgId: ORG, runId: RUN, relPath: "../../elsewhere.md" }),
    ).rejects.toMatchObject({ reason: "path_escape" });
    const written = await folder.writeRunOutputFile({
      orgId: ORG,
      runId: RUN,
      relPath: "nested/deep/report.md",
      bytes: enc("x"),
    });
    expect(written.relPath).toBe("nested/deep/report.md");
  });

  it("resolves under the root it is HANDED, so the root checked and the root used cannot diverge", async () => {
    const other = path.join(ROOT, "other-root");
    const resolved = await folder.resolveRunOutputPath(
      { orgId: ORG, runId: RUN, relPath: "report.md" },
      other,
    );
    expect(resolved.abs.startsWith(other + path.sep)).toBe(true);
    expect(path.relative(other, resolved.abs).startsWith("..")).toBe(false);
    expect(resolved.abs).toBe(path.join(other, ORG, RUN, "outputs", "report.md"));
  });
});
