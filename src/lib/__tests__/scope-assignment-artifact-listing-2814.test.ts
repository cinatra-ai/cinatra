/**
 * THE ARTIFACTS PANE'S PICKER READS THE WHOLE LISTING (cinatra#2814,
 * per-scope assignment S2).
 *
 * The artifact listing reads the newest rows per type in SQL and filters by
 * extension and authorization afterwards, one page at a time. A picker that
 * took one page would never offer an older eligible artifact, not even when
 * searched by its exact title. So the picker walks the listing's cursor to its
 * end, within a stated bound.
 */
import { describe, expect, it, vi } from "vitest";

import { collectArtifactListing } from "@/lib/scope-assignment/scope-assignment-reads.server";

const row = (id: string) => ({ artifactId: id, title: id, eligibleExtensions: [], primaryExtension: null, projectId: null });

describe("collectArtifactListing", () => {
  it("walks the cursor to the end of the listing", async () => {
    const readPage = vi.fn(async (cursor: string | null) =>
      cursor === null
        ? { artifacts: Array.from({ length: 100 }, (_, i) => row(`new_${i}`)), nextCursor: "c1" }
        : cursor === "c1"
          ? { artifacts: [], nextCursor: "c2" }
          : { artifacts: [row("old_eligible")], nextCursor: null },
    );
    const { artifacts, complete } = await collectArtifactListing(readPage);
    expect(artifacts).toHaveLength(101);
    expect(artifacts.at(-1)!.artifactId).toBe("old_eligible");
    expect(complete).toBe(true);
    expect(readPage.mock.calls.map((c) => c[0])).toEqual([null, "c1", "c2"]);
  });

  it("stops at its bound and says the walk is incomplete", async () => {
    let n = 0;
    const readPage = vi.fn(async () => ({ artifacts: [row(`r_${n}`)], nextCursor: `c${++n}` }));
    const { artifacts, complete } = await collectArtifactListing(readPage, 3);
    expect(artifacts).toHaveLength(3);
    expect(complete).toBe(false);
  });

  it("never loops on a cursor that does not move", async () => {
    const readPage = vi.fn(async () => ({ artifacts: [row("same")], nextCursor: "stuck" }));
    const { artifacts, complete } = await collectArtifactListing(readPage);
    expect(artifacts).toHaveLength(1);
    expect(complete).toBe(false);
    expect(readPage).toHaveBeenCalledTimes(2);
  });
});
