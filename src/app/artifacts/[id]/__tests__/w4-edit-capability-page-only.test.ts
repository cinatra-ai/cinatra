// THE EDITING SPLIT HOLDS (cinatra#3319, acceptance 7).
//
// "The editing split of enabler 0.20 holds unchanged: on the artifact page a
//  display may receive `grantArtifactEdit` under write rights; every other
//  Artifacts-area mount and the review mint `read-only-surface`; a test asserts
//  no `grantArtifactEdit` call is reachable from outside the artifact page."
//
// The split held before this change and must survive it: this leg rewrites every
// mount on both roads, and the one thing it must NOT move is which surface may
// mint an edit capability. Nothing pinned that before — the invariant lived in a
// comment — so it is pinned here, over the whole Artifacts area rather than over
// the files this leg happened to touch.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..", "..");
const THE_ARTIFACT_PAGE = "src/app/artifacts/[id]/page.tsx";
/** Where the capability is DEFINED — a definition is not a call site. */
const THE_DEFINITION = "src/lib/artifacts/artifact-renderer-props.ts";

function productionSources(root: string, out: string[] = []): string[] {
  for (const name of readdirSync(root)) {
    if (name === "node_modules" || name === "__tests__" || name === "__stubs__") continue;
    const full = join(root, name);
    if (statSync(full).isDirectory()) {
      productionSources(full, out);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(name)) continue;
    if (/\.(test|spec)\.tsx?$/.test(name)) continue;
    out.push(full);
  }
  return out;
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const AREA = [
  ...productionSources(join(REPO_ROOT, "src/app/artifacts")),
  ...productionSources(join(REPO_ROOT, "src/components/artifacts")),
  ...productionSources(join(REPO_ROOT, "src/lib/artifacts")),
];

function namesGrant(file: string): boolean {
  return /\bgrantArtifactEdit\b/.test(stripComments(readFileSync(file, "utf8")));
}

describe("acceptance 7 — grantArtifactEdit is reachable only from the artifact page", () => {
  it("no Artifacts-area production source outside the page names it, except where it is defined", () => {
    const named = AREA.filter(namesGrant).map((f) => relative(REPO_ROOT, f)).sort();
    expect(named).toEqual([THE_ARTIFACT_PAGE, THE_DEFINITION].sort());
  });

  it("the artifact page does mint it — the split is a split, not a ban", () => {
    const page = stripComments(readFileSync(join(REPO_ROOT, THE_ARTIFACT_PAGE), "utf8"));
    expect(page).toMatch(/grantArtifactEdit\(/);
  });

  it("every other Artifacts-area mount mints the named refusal instead", () => {
    for (const file of AREA) {
      const rel = relative(REPO_ROOT, file);
      if (rel === THE_ARTIFACT_PAGE || rel === THE_DEFINITION) continue;
      const text = stripComments(readFileSync(file, "utf8"));
      if (!/buildArtifactRendererProps\(/.test(text)) continue;
      expect(text, `${rel} builds display props without a read-only capability`).toMatch(
        /readOnlyArtifactEdit\(/,
      );
    }
  });

  it("the ONE shared mount both roads pass through mints no capability of its own", () => {
    // THE NEW ROAD THIS LEG BUILDS. Before it, the page and the review each
    // mounted their own tree, and the split was two separate readings of the
    // same rule. Now one module stands on both roads, so it is the one place a
    // page-minted capability could reach a review card: it takes the props
    // snapshot its caller already built and hands it straight to the display —
    // it never names the grant, and it never builds a snapshot of its own.
    const mount = stripComments(
      readFileSync(join(REPO_ROOT, "src/app/artifacts/[id]/artifact-display-mount.tsx"), "utf8"),
    );
    expect(mount).not.toMatch(/\bgrantArtifactEdit\b/);
    expect(mount).not.toMatch(/buildArtifactRendererProps\(/);
  });

  it("the review road mints the read-only surface by name", () => {
    const binder = stripComments(
      readFileSync(join(REPO_ROOT, "src/app/artifacts/[id]/review-target-prepare.ts"), "utf8"),
    );
    expect(binder).toMatch(/readOnlyArtifactEdit\("read-only-surface"\)/);
    expect(binder).not.toMatch(/\bgrantArtifactEdit\b/);
  });
});
