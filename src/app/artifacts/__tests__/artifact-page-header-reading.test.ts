/**
 * THE ARTIFACT PAGE'S HEADER READS THE HEAD REVISION, NOT THE FIRST ONE.
 *
 * cinatra#3026 (epic #3023, lifecycle-c W2). The page's header describes the
 * document under it — "text/markdown · N bytes". The form was already read from
 * the resolved head revision; the SIZE was read from `artifact.size`, the value
 * cached on the object row when the artifact was created.
 *
 * The save road behind the editor APPENDS a new revision with an expected base
 * and never touches that row, by design: a revision is immutable and the row's
 * cached size belongs to the revision that created it. So the reading stayed at
 * the first revision's size through every later save — measured on a real
 * surface as "6712 bytes" still on screen after five saved change sets, over a
 * document the store had grown.
 *
 * Both readings are already in hand at that point in the page: `resolved` is the
 * head revision the editor was opened on, and it carries its own `sizeBytes`
 * beside the `mime` the header already reads from it. This suite pins that the
 * header reads the same revision for both halves of its sentence.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const PAGE_PATH = "src/app/artifacts/[id]/page.tsx";

describe("the artifact page's header describes the HEAD revision (cinatra#3026)", () => {
  const PAGE = read(PAGE_PATH);

  it("the file path this suite reads is the page the router mounts", () => {
    expect(existsSync(path.join(ROOT, PAGE_PATH))).toBe(true);
  });

  it("the header's byte count comes from the resolved head revision", () => {
    expect(PAGE).toMatch(/const sizeBytes = resolved\?\.sizeBytes \?\? artifact\.size;/);
    expect(PAGE).toMatch(/description=\{`\$\{mime \|\| "unknown"\} · \$\{sizeBytes\} bytes`\}/);
  });

  it("the header no longer reads the size cached on the object row at creation", () => {
    expect(PAGE).not.toMatch(/\$\{artifact\.size\} bytes/);
  });

  it("the form and the size are read from ONE revision — the same one", () => {
    // `mime` already resolves head-first with the row as its floor; the size
    // must fall back the same way rather than by a different rule.
    expect(PAGE).toMatch(/const mime = resolved\?\.mime \?\? artifact\.mime/);
    expect(PAGE).toMatch(/resolved\?\.sizeBytes \?\? artifact\.size/);
  });

  it("the resolution the header reads is the EDITOR's revision, not a fresh latest", () => {
    // The page resolves the revision the editor opens on and serves the header
    // from that same resolution — one read, one revision, one sentence.
    expect(PAGE).toMatch(/resolveEditorRevisionId\(/);
    expect(PAGE).toMatch(/resolveArtifactVersionForServe\(\{/);
  });
});

/**
 * WHY THE CACHED ROW VALUE CANNOT BE THE HEADER'S SOURCE.
 *
 * This is the half that makes the defect a defect rather than a preference: the
 * append-with-expected-base road writes a representation row and nothing else.
 * If it ever did move the object row's cached size, this test goes red and the
 * reasoning above has to be re-read rather than silently outlived.
 */
describe("the save road does not move the object row's cached size", () => {
  const STORE = read("src/lib/artifacts/representation-store.ts");

  it("the file already says so in its own words, beside the cached pointer", () => {
    // The pointer half of this was fixed once already; the size is the same
    // cause reaching a second cached field on the same row.
    expect(STORE).toMatch(/deliberately does not touch that\n \* pointer/);
  });

  it("appendRepresentationWithExpectedBase writes no size onto the object row", () => {
    const start = STORE.indexOf("export async function appendRepresentationWithExpectedBase");
    expect(start, "the append road is not in this file any more").toBeGreaterThan(-1);
    const nextExport = STORE.indexOf("\nexport ", start + 1);
    const body = STORE.slice(start, nextExport === -1 ? undefined : nextExport);
    expect(body).not.toMatch(/UPDATE[\s\S]{0,200}?"objects"/i);
    expect(body).not.toMatch(/\bsize\b\s*=/);
  });
});
