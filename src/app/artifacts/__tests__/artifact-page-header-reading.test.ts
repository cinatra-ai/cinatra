/**
 * THE ARTIFACT PAGE'S HEADER READS ONE REVISION — AND NO LONGER READS A SIZE.
 *
 * cinatra#3026 (epic #3023, lifecycle-c W2) fixed a split reading. The header
 * described the document under it as "text/markdown · N bytes"; the form was
 * read from the resolved head revision, but the SIZE was read from
 * `artifact.size`, the value cached on the object row when the artifact was
 * created.
 *
 * The save road behind the editor APPENDS a new revision with an expected base
 * and never touches that row, by design: a revision is immutable and the row's
 * cached size belongs to the revision that created it. So the reading stayed at
 * the first revision's size through every later save — measured on a real
 * surface as "6712 bytes" still on screen after five saved change sets, over a
 * document the store had grown. #3026 fixed it by reading both halves of the
 * sentence from the SAME resolved revision.
 *
 * WHAT CHANGED, AND WHY THIS SUITE CHANGED WITH IT (cinatra#3091, lifecycle-d
 * W3). The sentence #3026 repaired no longer exists. The ratified drawing
 * (artifact-review §IV read with §XI) closes this header at a mono meta line of
 * SIX facts — type, pinned revision, owner level, visibility, MIME, updated
 * time — and names no seventh. A size is not one of them, so the page hands the
 * header none at all; `w3-artifact-page-header-closed` pins the closed line and
 * the six cells from the other side.
 *
 * So #3026's invariant is not repealed here, it is narrowed to what the header
 * still reads. The header's remaining revision-derived fact is the FORM, and it
 * must still resolve head-first from the same one resolution the editor opens
 * on. The half of #3026 that guarded the size travels with the size: a drawn
 * size now belongs to the per-kind download card (§V.2), not to this header,
 * and the rule it must keep is the same rule — a size drawn beside a form is
 * read from the revision that form came from, never from the row's cached
 * value.
 *
 * NOW CLOSED, IN THE LEG THAT PROVES THIS SURFACE: the host's own generic
 * floor, `handlers/fallback-handler.tsx`, is §V.2's card for a file nothing of
 * ours can read, and it drew its Size row from `artifact.size` — the row's
 * cached value, the same stale reading #3026 removed from the header. It now
 * reads the size of the representation the page resolved, the very bytes its
 * own download control hands over, and falls back to the cached value only for
 * a row that resolved no representation at all (which draws no download either,
 * so nothing can disagree with it there). The assertion this docblock said
 * would be written in that leg is
 * `handlers/__tests__/w3-download-card-size-is-the-resolved-revisions.test.tsx`,
 * red on the previous head and green here.
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

  it("the header is handed no byte count at all — the drawn line carries none", () => {
    // The reading #3026 repaired was removed rather than re-pointed: the
    // drawing closes the meta line without a size, so the page resolves none
    // and passes none. This is the assertion that would have gone red before
    // the header was closed, when the page still computed a size for it.
    //
    // READ OVER THE HEADER'S OWN CONSTRUCTION, not the whole page file. The
    // drawing that closes THIS line also draws a size on the per-kind download
    // card (V.2), so the page legitimately resolves one for that card; a
    // file-wide ban on the token would forbid the drawing's own reading. The
    // rule is, and always was, about what reaches the header.
    const headerCall = PAGE.match(/const header = buildArtifactDetailHeader\(\{[\s\S]*?\}\);/);
    expect(headerCall).not.toBeNull();
    expect(headerCall?.[0]).not.toMatch(/size/i);
    expect(PAGE).not.toMatch(/\$\{mime \|\| "unknown"\} · \$\{sizeBytes\} bytes/);
  });

  it("the header no longer reads the size cached on the object row at creation", () => {
    // Unchanged from #3026 and still the point: whatever this page draws, it
    // never draws the row's creation-time size as a count of bytes.
    expect(PAGE).not.toMatch(/\$\{artifact\.size\} bytes/);
  });

  it("the fact the header DOES take from a revision is read head-first", () => {
    // `mime` is the surviving revision-derived cell of the six. It resolves
    // head-first with the row as its floor — the rule #3026 established, kept
    // for the reading that outlived the sentence.
    expect(PAGE).toMatch(/const mime = resolved\?\.mime \?\? artifact\.mime/);
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
