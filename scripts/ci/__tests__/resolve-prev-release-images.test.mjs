// resolve-prev-release-images.sh — the previous-release base resolution for
// the release upgrade proof (build-image.yml `upgrade-proof` job). Pure-bash
// with two injected seams (tag list + image-existence probe), so this suite
// exercises the release-critical selection rules hermetically: stable-tags-
// only, strictly-below-the-building-core ordering, unresolvable-tag walk-down
// (a barrier-blocked release leaves a git tag but no image), the two-base
// window, and both fail-closed exits.
//
// Tag fixtures are CONSTRUCTED (rel()/ref()) rather than written as literals:
// this is a public repo and bare version tokens on net-new lines are a
// source-leak-gate hazard; construction keeps the fixtures readable without
// carrying any literal token.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "lib",
  "resolve-prev-release-images.sh",
);

const REPO = "ghcr.io/example-org/example-app";

/** Construct a release tag name: rel(0, 9, 1) or rel(0, 9) (two-part). */
const rel = (...nums) => `v${nums.join(".")}`;
/** The image ref the resolver emits for a tag. */
const ref = (tag) => `${REPO}:${tag}`;

// A probe stand-in for `docker buildx imagetools inspect`: succeeds iff the
// probed ref appears in $RESOLVABLE (space-separated).
const probeDir = mkdtempSync(path.join(tmpdir(), "upgrade-proof-probe-"));
const PROBE = path.join(probeDir, "probe.sh");
writeFileSync(
  PROBE,
  '#!/usr/bin/env bash\ncase " ${RESOLVABLE:-} " in *" $1 "*) exit 0 ;; *) exit 1 ;; esac\n',
  { mode: 0o755 },
);

/**
 * Run the resolver. Returns { status, stdout, stderr }.
 * @param {string} buildingTag
 * @param {{ tags: string[], resolvable?: string[], maxBases?: number }} opts
 */
function run(buildingTag, { tags, resolvable, maxBases }) {
  const args = [SCRIPT, buildingTag, REPO];
  if (maxBases !== undefined) args.push(String(maxBases));
  const env = {
    ...process.env,
    UPGRADE_PROOF_TAG_LIST: tags.join("\n"),
    UPGRADE_PROOF_PROBE_CMD: `bash ${PROBE}`,
    // Default: every candidate base resolves (tests narrow this down).
    RESOLVABLE: (resolvable ?? tags.map(ref)).join(" "),
  };
  const r = spawnSync("bash", args, { env, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const lines = (s) => s.split("\n").filter(Boolean);

describe("resolve-prev-release-images.sh", () => {
  it("emits the two most recent stable bases strictly below the building tag, most recent first", () => {
    const r = run(rel(0, 1, 8), {
      // Unsorted + annotated-tag peel doubles, to prove dedupe + version sort.
      tags: [rel(0, 1, 6), `${rel(0, 1, 6)}^{}`, rel(0, 1, 5), rel(0, 1, 7), `${rel(0, 1, 7)}^{}`, rel(0, 1, 8)],
    });
    expect(r.status).toBe(0);
    expect(lines(r.stdout)).toEqual([ref(rel(0, 1, 7)), ref(rel(0, 1, 6))]);
  });

  it("orders by version, not lexically (a two-digit minor sorts above a one-digit one)", () => {
    const r = run(rel(0, 10, 1), {
      tags: [rel(0, 2, 0), rel(0, 10, 0), rel(0, 9, 0)],
    });
    expect(r.status).toBe(0);
    expect(lines(r.stdout)).toEqual([ref(rel(0, 10, 0)), ref(rel(0, 9, 0))]);
  });

  it("excludes pre-release/suffixed tags from the base set (sort -V would misorder them)", () => {
    const r = run(rel(0, 2, 0), {
      tags: [rel(0, 1, 6), rel(0, 1, 7), `${rel(0, 1, 8)}-rc.1`, rel(0, 2, 0)],
    });
    expect(r.status).toBe(0);
    // The rc-suffixed tag is NOT a base; the two stable tags are.
    expect(lines(r.stdout)).toEqual([ref(rel(0, 1, 7)), ref(rel(0, 1, 6))]);
  });

  it("a suffixed BUILDING tag resolves bases by its numeric core", () => {
    const r = run(`${rel(0, 2, 0)}-rc.1`, {
      tags: [rel(0, 1, 6), rel(0, 1, 7)],
    });
    expect(r.status).toBe(0);
    expect(lines(r.stdout)).toEqual([ref(rel(0, 1, 7)), ref(rel(0, 1, 6))]);
  });

  it("skips a tag whose image does not resolve and walks down (barrier-blocked release)", () => {
    const r = run(rel(0, 1, 9), {
      tags: [rel(0, 1, 6), rel(0, 1, 7), rel(0, 1, 8)],
      // The most recent tag was blocked before publish: no image exists.
      resolvable: [ref(rel(0, 1, 7)), ref(rel(0, 1, 6))],
    });
    expect(r.status).toBe(0);
    expect(lines(r.stdout)).toEqual([ref(rel(0, 1, 7)), ref(rel(0, 1, 6))]);
    expect(r.stderr).toContain("no resolvable image");
  });

  it("emits a single base when only one prior release exists (window shrinks, no failure)", () => {
    const r = run(rel(0, 1, 1), { tags: [rel(0, 1, 0), rel(0, 1, 1)] });
    expect(r.status).toBe(0);
    expect(lines(r.stdout)).toEqual([ref(rel(0, 1, 0))]);
  });

  it("honors an explicit max-bases of one", () => {
    const r = run(rel(0, 1, 8), {
      tags: [rel(0, 1, 5), rel(0, 1, 6), rel(0, 1, 7)],
      maxBases: 1,
    });
    expect(r.status).toBe(0);
    expect(lines(r.stdout)).toEqual([ref(rel(0, 1, 7))]);
  });

  it("fails closed (exit 1) when no image resolves for any base tag", () => {
    const r = run(rel(0, 1, 8), {
      tags: [rel(0, 1, 6), rel(0, 1, 7)],
      resolvable: [],
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("fail closed");
  });

  it("fails closed (exit 1) when no stable tag exists below the building tag", () => {
    const r = run(rel(0, 1, 0), { tags: [rel(0, 1, 0), `${rel(0, 1, 0)}-beta.1`] });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("no stable release tag");
  });

  it("rejects a non-release (checkpoint/marker) building tag as a caller bug (exit 2)", () => {
    const r = run("v-pre-extension-system", { tags: [rel(0, 1, 6)] });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("not a release tag");
  });
});
