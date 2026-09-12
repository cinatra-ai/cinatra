// The design conformance PIN-DRIFT gate (cinatra#3057).
//
// Runs in the root Vitest suite (the gate of record) like its siblings in this
// directory: `scripts/ci/__tests__/**` is in the root include, so a suite here
// is executed wholesale by `pnpm test:root` and a failure reds a required
// check. The GATE ITSELF stays dependency-free (node builtins + git only) so
// the pure-node `gates` job can run it without an install; only this suite
// needs vitest.
//
// The suite is organised by the six acceptance criteria of cinatra#3057 and
// pins each of them against REAL inputs wherever a real input exists:
//
//   1. OUTCOMES. The five FROZEN published manifests (fetched 2026-09-12,
//      committed verbatim under __fixtures__) are run against the REAL
//      conformance-pins.json. The 2026-09-12 reconciliation ADOPTED four of
//      those bodies — app, app-components and app-extensions re-pinned
//      hashes-only, app-notifications never moved — so they are the zero-drift
//      set together with the committed manifest copies they are byte-identical
//      to, and that identity IS the adoption record. The fifth,
//      app-connectors, is asserted as a `drift`: its published body redeclares
//      the manifest, so it is adopted with its drivers where those live, and
//      until then the pin names the artifact before it. The drift path keeps
//      real inputs of its own: the SUPERSEDED bodies (the artifacts the pins
//      named before a reconciliation, frozen beside the published ones) must
//      still report `drift`s, in both hashes. A gate whose drift path has no
//      input is a gate whose drift path is untested.
//      One fixture each drives `http-failure`, `invalid-json` and
//      `schema-failure` BY NAME, because the failure a gate never names is
//      the failure it silently passes.
//   2. TRIGGER. The path map's intersection rule, in all four directions.
//   3. HYGIENE. The real pin file carries no provenance key, and the
//      structural check REFUSES one on a fixture pin.
//   4. RED MESSAGE. Its exact content — and, negatively, that it says
//      nothing about the upstream source beyond the published URL.
//   5/6. Held by the diff, not by a suite (a docs page and the ABSENCE of a
//      branch-protection edit); the map-integrity test below is the part of
//      criterion 5 a suite CAN hold: every mapped path really exists.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CHECKER_PATH,
  DRIVER_FILE_PATH,
  GLOBAL_PATHS,
  MAP_PATH,
  MOVE_RULE,
  PIN_ENTRY_KEYS,
  PINS_PATH,
  WORKFLOW_PATH,
  changedMapPinIdsBetween,
  changedPinIdsBetween,
  checkPinsStructure,
  classifyPin,
  decide,
  driverBlocks,
  driverFilePinIds,
  formatRedMessage,
  formatTable,
  loadMap,
  loadPinSurfaceIds,
  loadPins,
  parseChangedLineRanges,
  parseRemovedLineRanges,
  publishedUrlFor,
  resolveEvent,
  resolveTouchedPinIds,
  runCheck,
  runCli,
} from "../design-pin-drift.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
  "design-pin-drift",
);
const FROZEN_PUBLISHED = path.join(FIXTURES, "published-2026-09-12");
/**
 * The published set frozen by the cinatra#3057 reconciliation. It is still the
 * record of THAT adoption — the two tests that compare what a published body
 * redeclared against what it superseded read it — and nothing about the
 * 2026-09-12 hashes-only re-pin retires it.
 */
const FROZEN_PUBLISHED_2026_08_28 = path.join(FIXTURES, "published-2026-08-28");
/**
 * The artifacts the pins named BEFORE the cinatra#3057 reconciliation. They
 * are the suite's EVERY-pin drift input: each of the five still differs from
 * the pin it belongs to in both hashes, the 2026-09-12 re-pin included. See
 * the provenance receipt beside them.
 */
const SUPERSEDED = path.join(FIXTURES, "superseded-pins-2026-08-28");
/**
 * The three artifacts the pins named before the 2026-09-12 hashes-only
 * reconciliation. Three, not five: that reconciliation moved app,
 * app-components and app-extensions only — app-connectors and
 * app-notifications kept the pins they had.
 */
const SUPERSEDED_2026_09_12 = path.join(FIXTURES, "superseded-pins-2026-09-12");
const MALFORMED = path.join(FIXTURES, "malformed");

const pins = loadPins(REPO_ROOT);
const map = loadMap(REPO_ROOT);
const ALL_IDS = pins.manifests.map((pin) => pin.id);

/** A fetcher that serves committed fixture bytes for every pin's URL. */
function fixtureFetcher(dirOrResolver) {
  return async (url) => {
    const file = url.slice(url.lastIndexOf("/") + 1);
    const resolved =
      typeof dirOrResolver === "function"
        ? dirOrResolver(file)
        : { body: readFileSync(path.join(dirOrResolver, file)) };
    if (resolved.error) return { ok: false, status: 0, error: resolved.error };
    return { ok: true, status: 200, body: resolved.body, ...resolved };
  };
}

const outcomesOf = (results) => results.map((r) => r.outcome);
const byId = (results, id) => results.find((r) => r.id === id);

// ---------------------------------------------------------------------------
// Criterion 1 — outcomes
// ---------------------------------------------------------------------------

describe("criterion 1 — the five outcomes are reported, never silently passed", () => {
  it("the superseded pinned artifacts drift against every pin on main", async () => {
    // The drift path's real input after the reconciliation: the five bodies
    // the pins named BEFORE it. Serving them back is exactly the shape of the
    // red this gate exists to raise, so nothing about that red went untested
    // when the published bodies stopped drifting.
    const results = await runCheck({
      pins,
      fetchManifest: fixtureFetcher(SUPERSEDED),
    });
    expect(results).toHaveLength(5);
    expect(outcomesOf(results)).toEqual(["drift", "drift", "drift", "drift", "drift"]);
    // Every drift names BOTH hashes it compared, in both directions.
    for (const result of results) {
      expect(result.pinnedManifestSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(result.publishedManifestSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(result.publishedManifestSha256).not.toBe(result.pinnedManifestSha256);
      expect(result.publishedSpecContentHash).not.toBe(result.pinnedSpecContentHash);
    }
  });

  it("the frozen 2026-09-12 published manifests are the ADOPTED bytes and every reconciled pin matches", async () => {
    // The reconciliation's own record, held as an assertion rather than as
    // prose: the pins name the bytes docs.cinatra.ai served, and the
    // committed copies under manifests/ are those same bytes verbatim.
    //
    // FOUR of the five, not all five. `app-connectors` is the one pin this
    // reconciliation does not adopt: its published body redeclares the
    // manifest (three sharing surfaces gained), so it moves together with the
    // drivers and harness mounts that answer those surfaces, in the PR where
    // those live. Until that lands the pin names the artifact before it.
    // Asserting that pin as `drift` — rather than dropping it from the list —
    // is what keeps the exception visible in the suite instead of silent.
    const RECONCILED = ["app", "app-components", "app-extensions", "app-notifications"];
    const results = await runCheck({
      pins,
      fetchManifest: fixtureFetcher(FROZEN_PUBLISHED),
    });
    expect(results).toHaveLength(5);
    expect(outcomesOf(results)).toEqual(["match", "match", "match", "drift", "match"]);
    expect(byId(results, "app-connectors").outcome).toBe("drift");
    // The push-to-main arm is red on ANY non-match outcome, and it says so:
    // that single drift is the state of main until the adoption lands.
    const verdict = decide({ event: "push-main", results, touchedPinIds: [] });
    expect(verdict.red).toBe(true);
    expect(verdict.failing.map((r) => r.id)).toEqual(["app-connectors"]);
    for (const pin of pins.manifests) {
      const published = readFileSync(path.join(FROZEN_PUBLISHED, pin.file));
      const committed = readFileSync(
        path.join(REPO_ROOT, "tests/e2e/design/conformance/manifests", pin.file),
      );
      if (RECONCILED.includes(pin.id)) {
        expect(
          published,
          `${pin.id}: the committed copy is not the published artifact verbatim`,
        ).toEqual(committed);
      } else {
        expect(
          published,
          `${pin.id}: the committed copy adopted the published body without its drivers`,
        ).not.toEqual(committed);
      }
    }
  });

  it("the committed manifest copies are the zero-drift set and every pin matches", async () => {
    const results = await runCheck({
      pins,
      fetchManifest: fixtureFetcher((file) => ({
        body: readFileSync(
          path.join(REPO_ROOT, "tests/e2e/design/conformance/manifests", file),
        ),
      })),
    });
    expect(outcomesOf(results)).toEqual(["match", "match", "match", "match", "match"]);
    expect(decide({ event: "push-main", results, touchedPinIds: [] }).red).toBe(false);
  });

  it("a network error or a non-2xx status is http-failure, by name", async () => {
    const networkError = await runCheck({
      pins,
      fetchManifest: async () => {
        throw new Error("getaddrinfo ENOTFOUND");
      },
    });
    expect(outcomesOf(networkError)).toEqual(Array(5).fill("http-failure"));

    const notFound = await runCheck({
      pins,
      fetchManifest: async () => ({
        ok: false,
        status: 404,
        body: readFileSync(path.join(MALFORMED, "http-error-page.html")),
      }),
    });
    expect(outcomesOf(notFound)).toEqual(Array(5).fill("http-failure"));
    expect(byId(notFound, "app").detail).toContain("404");
  });

  it("an HTML body served with a 200 is invalid-json, by name", async () => {
    const results = await runCheck({
      pins,
      fetchManifest: fixtureFetcher(() => ({
        body: readFileSync(path.join(MALFORMED, "http-error-page.html")),
      })),
    });
    expect(outcomesOf(results)).toEqual(Array(5).fill("invalid-json"));
    // NOT a drift: an unparsable body must never be reported as a hash change.
    expect(results.every((r) => r.outcome !== "drift")).toBe(true);
  });

  it("an unsupported schemaVersion, a missing contentHash and a malformed contentHash are schema-failure, by name", async () => {
    for (const fixture of [
      "schema-version-unsupported.json",
      "content-hash-missing.json",
      "content-hash-malformed.json",
    ]) {
      const results = await runCheck({
        pins,
        fetchManifest: fixtureFetcher(() => ({
          body: readFileSync(path.join(MALFORMED, fixture)),
        })),
      });
      expect(outcomesOf(results), fixture).toEqual(Array(5).fill("schema-failure"));
    }
  });

  it("classifies drift when ONLY the embedded contentHash moved", () => {
    // The two hashes are compared unconditionally, so each must be able to
    // fire ALONE. Isolating the embedded hash means pinning the tampered
    // body's OWN manifestSha256 — otherwise the body edit moves both hashes
    // and the test passes even with the contentHash comparison deleted.
    const pin = pins.manifests[0];
    const committed = readFileSync(
      path.join(REPO_ROOT, "tests/e2e/design/conformance/manifests", pin.file),
    );
    const movedHash = `sha256:${"0".repeat(64)}`;
    const body = Buffer.from(
      JSON.stringify({ ...JSON.parse(committed.toString("utf8")), contentHash: movedHash }),
    );
    const isolatingPin = { ...pin, manifestSha256: createHash("sha256").update(body).digest("hex") };
    const result = classifyPin({
      pin: isolatingPin,
      url: publishedUrlFor(pins, isolatingPin),
      fetched: { ok: true, status: 200, body },
    });
    expect(result.publishedManifestSha256).toBe(isolatingPin.manifestSha256);
    expect(result.outcome).toBe("drift");
    expect(result.publishedSpecContentHash).toBe(movedHash);
    expect(result.detail).toContain("specContentHash");
    expect(result.detail).not.toContain("manifestSha256");
  });

  it("classifies drift when ONLY the manifest bytes moved", () => {
    // The converse: the embedded hash still agrees, the bytes do not. A
    // whitespace-only republication is exactly this case.
    const pin = pins.manifests[0];
    const committed = readFileSync(
      path.join(REPO_ROOT, "tests/e2e/design/conformance/manifests", pin.file),
    );
    const body = Buffer.concat([committed, Buffer.from("\n")]);
    const result = classifyPin({
      pin,
      url: publishedUrlFor(pins, pin),
      fetched: { ok: true, status: 200, body },
    });
    expect(result.publishedSpecContentHash).toBe(pin.specContentHash);
    expect(result.outcome).toBe("drift");
    expect(result.detail).toContain("manifestSha256");
    expect(result.detail).not.toContain("specContentHash");
  });

  it("the frozen fixtures carry a capture receipt every row of which describes their real bytes", () => {
    // A fixture nobody can re-derive is a fixture nobody can trust. The receipt
    // records the exact URL, date, status, byte length and hash of each frozen
    // body, so `curl -sS <url> | shasum -a 256` re-checks any row by hand.
    const receipt = JSON.parse(readFileSync(path.join(FROZEN_PUBLISHED, "capture.json"), "utf8"));
    expect(receipt.fetchedAt).toBe("2026-09-12");
    expect(receipt.publishedBaseUrl).toBe(pins.publishedBaseUrl);
    expect(receipt.manifests.map((m) => m.file)).toEqual(pins.manifests.map((p) => p.file));
    for (const row of receipt.manifests) {
      const bytes = readFileSync(path.join(FROZEN_PUBLISHED, row.file));
      expect(row.url, row.file).toBe(`${pins.publishedBaseUrl}${row.file}`);
      expect(row.httpStatus, row.file).toBe(200);
      expect(bytes.length, row.file).toBe(row.byteLength);
      expect(createHash("sha256").update(bytes).digest("hex"), row.file).toBe(row.sha256);
      const parsed = JSON.parse(bytes.toString("utf8"));
      expect(parsed.schemaVersion, row.file).toBe(row.schemaVersion);
      expect(parsed.contentHash, row.file).toBe(row.contentHash);
      // Every recorded hash IS the pin: this receipt is the provenance of the
      // adoption — the pins name bytes whose fetch is recorded, not bytes
      // someone typed.
      const pin = pins.manifests.find((p) => p.file === row.file);
      if (pin.id === "app-connectors") {
        // The one row this reconciliation did not adopt (see above): the
        // receipt records the body that was served, the pin still names the
        // artifact before it, and the difference is the drift on main.
        expect(row.sha256, row.file).not.toBe(pin.manifestSha256);
        expect(row.contentHash, row.file).not.toBe(pin.specContentHash);
      } else {
        expect(row.sha256, row.file).toBe(pin.manifestSha256);
        expect(row.contentHash, row.file).toBe(pin.specContentHash);
      }
    }
  });

  it("the superseded fixtures carry a provenance receipt every row of which describes their real bytes", () => {
    // Same bar as the capture receipt: a drift input nobody can re-derive is a
    // drift input nobody can trust. `git show <sourceCommit>:<repoPath>`
    // re-checks any row by hand.
    const receipt = JSON.parse(readFileSync(path.join(SUPERSEDED, "provenance.json"), "utf8"));
    expect(receipt.sourceCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(receipt.manifests.map((m) => m.file)).toEqual(pins.manifests.map((p) => p.file));
    for (const row of receipt.manifests) {
      const bytes = readFileSync(path.join(SUPERSEDED, row.file));
      expect(row.repoPath, row.file).toBe(
        `tests/e2e/design/conformance/manifests/${row.file}`,
      );
      expect(bytes.length, row.file).toBe(row.byteLength);
      expect(createHash("sha256").update(bytes).digest("hex"), row.file).toBe(row.sha256);
      const parsed = JSON.parse(bytes.toString("utf8"));
      expect(parsed.schemaVersion, row.file).toBe(row.schemaVersion);
      expect(parsed.contentHash, row.file).toBe(row.contentHash);
      // Every recorded hash differs from the pin: this IS what a drift is.
      const pin = pins.manifests.find((p) => p.file === row.file);
      expect(row.sha256, row.file).not.toBe(pin.manifestSha256);
      expect(row.contentHash, row.file).not.toBe(pin.specContentHash);
    }
  });

  it("the 2026-09-12 superseded artifacts drift against the three pins that reconciliation moved", () => {
    // The drift input of the hashes-only reconciliation: the bodies those
    // three entries named before it. A superseded artifact that still matched
    // its pin would mean nothing was re-pinned at all.
    const receipt = JSON.parse(
      readFileSync(path.join(SUPERSEDED_2026_09_12, "provenance.json"), "utf8"),
    );
    expect(receipt.sourceCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(receipt.manifests.map((m) => m.file)).toEqual([
      "app.json",
      "app-components.json",
      "app-extensions.json",
    ]);
    for (const row of receipt.manifests) {
      const bytes = readFileSync(path.join(SUPERSEDED_2026_09_12, row.file));
      expect(row.repoPath, row.file).toBe(
        `tests/e2e/design/conformance/manifests/${row.file}`,
      );
      expect(bytes.length, row.file).toBe(row.byteLength);
      expect(createHash("sha256").update(bytes).digest("hex"), row.file).toBe(row.sha256);
      const parsed = JSON.parse(bytes.toString("utf8"));
      expect(parsed.schemaVersion, row.file).toBe(row.schemaVersion);
      expect(parsed.contentHash, row.file).toBe(row.contentHash);

      const pin = pins.manifests.find((p) => p.file === row.file);
      const result = classifyPin({
        pin,
        url: publishedUrlFor(pins, pin),
        fetched: { ok: true, status: 200, body: bytes },
      });
      expect(result.outcome, row.file).toBe("drift");
      expect(result.detail, row.file).toContain("manifestSha256");
      expect(result.detail, row.file).toContain("specContentHash");

      // And the whole point of that reconciliation, as an assertion: the body
      // adopted in its place declares byte-identical surfaces. Only the two
      // hashes moved, so only this gate could see it — a surface-shape
      // comparison would have called these three unchanged.
      const declarations = (buffer) => {
        const object = JSON.parse(buffer.toString("utf8"));
        delete object.contentHash;
        return JSON.stringify(object);
      };
      expect(declarations(bytes), row.file).toBe(
        declarations(readFileSync(path.join(FROZEN_PUBLISHED, row.file))),
      );
    }
  });

  it("three of the five adopted drifts changed NOTHING the manifest declares — only the hashes", () => {
    // Why both hashes are compared unconditionally: for app-extensions,
    // app-connectors and app-notifications the published body and the
    // superseded one declare byte-identical surfaces. A surface-shape
    // comparison would report those three as unchanged; only the hashes see
    // them, and only this gate does. The other two — app (a surface gained)
    // and app-components (one retired, two gained) — reach the
    // functional-acceptance suite as well, and the reconciliation is what
    // makes that split a fact rather than a claim.
    const declarationsOnly = (bytes) => {
      // contentHash is the SPEC hash, not something the manifest DECLARES —
      // dropping it is what makes this a comparison of the declarations.
      const parsed = JSON.parse(bytes.toString("utf8"));
      delete parsed.contentHash;
      return JSON.stringify(parsed);
    };
    const identical = [];
    const redeclared = [];
    for (const pin of pins.manifests) {
      const adopted = readFileSync(path.join(FROZEN_PUBLISHED_2026_08_28, pin.file));
      const superseded = readFileSync(path.join(SUPERSEDED, pin.file));
      // Whichever class it is, it WAS a drift: neither hash survived.
      expect(
        createHash("sha256").update(adopted).digest("hex"),
        pin.id,
      ).not.toBe(createHash("sha256").update(superseded).digest("hex"));
      if (declarationsOnly(adopted) === declarationsOnly(superseded)) identical.push(pin.id);
      else redeclared.push(pin.id);
    }
    expect(identical).toEqual(["app-extensions", "app-connectors", "app-notifications"]);
    expect(redeclared).toEqual(["app", "app-components"]);
  });

  it("the two redeclaring adoptions gained and retired exactly the surfaces the record names", () => {
    // The reconciliation's coverage claim, asserted against the artifacts
    // themselves: a later re-pin that quietly drops a surface (or brings the
    // retired one back) cannot leave this record standing.
    const surfaceIds = (dir, file) =>
      JSON.parse(readFileSync(path.join(dir, file), "utf8")).surfaces.map((s) => s.id);
    const moved = (file) => {
      const before = new Set(surfaceIds(SUPERSEDED, file));
      const after = new Set(surfaceIds(FROZEN_PUBLISHED_2026_08_28, file));
      return {
        gained: [...after].filter((id) => !before.has(id)),
        retired: [...before].filter((id) => !after.has(id)),
      };
    };
    expect(moved("app.json")).toEqual({
      gained: [
        "sidebar-assistants-entry",
        "sidebar-workspace-entry",
        "workspace-scope-page",
        "workspace-scope-empty-tab",
      ],
      retired: [],
    });
    expect(moved("app-components.json")).toEqual({
      gained: ["breadcrumb-entity-resolution", "scheduling-step-configured"],
      retired: ["scheduling-trigger-tab"],
    });
  });
});

// ---------------------------------------------------------------------------
// Criterion 2 — the trigger rule
// ---------------------------------------------------------------------------

describe("criterion 2 — the trigger rule", () => {
  const driftedAll = ALL_IDS.map((id) => ({ id, outcome: "drift" }));

  it("a PR diff touching one drifted pin's mapped paths is red naming ONLY that pin", async () => {
    const touched = [map.pins["app-connectors"][0]];
    const touchedPinIds = resolveTouchedPinIds({ touchedPaths: touched, map });
    expect(touchedPinIds).toEqual(["app-connectors"]);
    const verdict = decide({ event: "pull_request", results: driftedAll, touchedPinIds });
    expect(verdict.red).toBe(true);
    expect(verdict.failing.map((r) => r.id)).toEqual(["app-connectors"]);
    expect(verdict.warning.map((r) => r.id)).toEqual(
      ALL_IDS.filter((id) => id !== "app-connectors"),
    );
  });

  it("a PR diff touching nothing in the map gets a warning annotation and exit 0", () => {
    const touchedPinIds = resolveTouchedPinIds({
      touchedPaths: ["src/lib/unrelated-module.ts", "README.md"],
      map,
    });
    expect(touchedPinIds).toEqual([]);
    const verdict = decide({ event: "pull_request", results: driftedAll, touchedPinIds });
    expect(verdict.red).toBe(false);
    expect(verdict.exitCode).toBe(0);
    expect(verdict.warning).toHaveLength(5);
  });

  it("a diff touching the checker or the workflow is red for EVERY drifted pin", () => {
    for (const global of [CHECKER_PATH, WORKFLOW_PATH]) {
      const touchedPinIds = resolveTouchedPinIds({ touchedPaths: [global], map });
      expect(touchedPinIds, global).toEqual(ALL_IDS);
      const verdict = decide({ event: "pull_request", results: driftedAll, touchedPinIds });
      expect(verdict.red, global).toBe(true);
      expect(verdict.failing.map((r) => r.id), global).toEqual(ALL_IDS);
    }
  });

  it("a PR that re-pins ONE entry is never blocked by the other four", () => {
    // The pin file is shared, so a whole-file rule would red a one-pin fix on
    // the four drifts it did not touch. Entry granularity is what prevents it.
    const touchedPinIds = resolveTouchedPinIds({
      touchedPaths: [PINS_PATH],
      map,
      changedPinIds: ["app-components"],
    });
    expect(touchedPinIds).toEqual(["app-components"]);
    const stillDrifted = driftedAll.filter((r) => r.id !== "app-components");
    const verdict = decide({ event: "pull_request", results: stillDrifted, touchedPinIds });
    expect(verdict.red).toBe(false);
  });

  it("a pin-file diff whose changed entries cannot be determined touches every id (fail-closed)", () => {
    expect(resolveTouchedPinIds({ touchedPaths: [PINS_PATH], map })).toEqual(ALL_IDS);
  });

  it("a main push or a dispatch is red on ANY non-match outcome, touched or not", () => {
    for (const event of ["push-main", "workflow_dispatch"]) {
      for (const outcome of ["drift", "http-failure", "invalid-json", "schema-failure"]) {
        const results = [{ id: "app", outcome }];
        const verdict = decide({ event, results, touchedPinIds: [] });
        expect(verdict.red, `${event}/${outcome}`).toBe(true);
        expect(verdict.exitCode, `${event}/${outcome}`).toBe(1);
        expect(verdict.failing.map((r) => r.id)).toEqual(["app"]);
      }
    }
  });

  it("a push to a branch other than main is treated as a PR-class run", () => {
    const verdict = decide({ event: "push", results: driftedAll, touchedPinIds: [] });
    expect(verdict.red).toBe(false);
  });

  it("a map that drops a global path cannot disarm the every-id rule", () => {
    // The rule lives in the checker, not in the map: a map able to remove its
    // own path from globalPaths would be a map that can edit away the rule
    // that makes editing it matter.
    const tampered = { ...map, globalPaths: [] };
    expect(resolveTouchedPinIds({ touchedPaths: [CHECKER_PATH], map: tampered })).toEqual(ALL_IDS);
    expect(resolveTouchedPinIds({ touchedPaths: [WORKFLOW_PATH], map: tampered })).toEqual(ALL_IDS);
    // The map left that set in cinatra#3421, but nothing it can say about
    // itself narrows the rule: with no readable base entry list it is still
    // every id, and `loadMap` refuses a declared set the checker disagrees
    // with before any of this is reached.
    expect(resolveTouchedPinIds({ touchedPaths: [MAP_PATH], map: tampered })).toEqual(ALL_IDS);
    expect(GLOBAL_PATHS).toEqual([CHECKER_PATH, WORKFLOW_PATH]);
  });

  it("changedPinIdsBetween names the entries that moved, and a moved base URL moves every pin", () => {
    const head = JSON.parse(readFileSync(path.join(REPO_ROOT, PINS_PATH), "utf8"));
    const text = (o) => JSON.stringify(o);

    expect(changedPinIdsBetween(text(head), text(head))).toEqual([]);
    expect(changedPinIdsBetween(text(head), text({ ...head, $comment: "reworded" }))).toEqual([]);

    const repinned = {
      ...head,
      manifests: head.manifests.map((pin) =>
        pin.id === "app-components" ? { ...pin, manifestSha256: "a".repeat(64) } : pin,
      ),
    };
    expect(changedPinIdsBetween(text(head), text(repinned))).toEqual(["app-components"]);

    // publishedBaseUrl is the URL all five fetches are built from: moving it
    // adopts every pin at once, though no entry moved.
    const moved = { ...head, publishedBaseUrl: "https://docs.cinatra.ai/references/design/v2/" };
    expect(changedPinIdsBetween(text(head), text(moved))).toEqual(ALL_IDS);
  });

  it("resolves the event class from the CI environment", () => {
    expect(resolveEvent({ env: { GITHUB_EVENT_NAME: "pull_request" } })).toBe("pull_request");
    expect(resolveEvent({ env: { GITHUB_EVENT_NAME: "merge_group" } })).toBe("merge_group");
    expect(
      resolveEvent({ env: { GITHUB_EVENT_NAME: "push", GITHUB_REF_NAME: "main" } }),
    ).toBe("push-main");
    expect(
      resolveEvent({ env: { GITHUB_EVENT_NAME: "push", GITHUB_REF_NAME: "ci/3057-x" } }),
    ).toBe("push");
    expect(resolveEvent({ argv: ["--event", "push-main"], env: {} })).toBe("push-main");
    // No environment at all is a MANUAL run, which is strict by design.
    expect(resolveEvent({ env: {} })).toBe("workflow_dispatch");
  });

  it("every path in the map exists, and every pin id is mapped", () => {
    expect(Object.keys(map.pins).sort()).toEqual([...ALL_IDS].sort());
    for (const [id, paths] of Object.entries(map.pins)) {
      expect(paths.length, id).toBeGreaterThan(0);
      for (const p of paths) {
        expect(
          () => readFileSync(path.join(REPO_ROOT, p)),
          `${id} maps ${p}, which does not exist`,
        ).not.toThrow();
      }
    }
    for (const p of map.globalPaths) {
      expect(() => readFileSync(path.join(REPO_ROOT, p)), p).not.toThrow();
    }
    expect(map.globalPaths).toEqual([CHECKER_PATH, WORKFLOW_PATH]);
  });

  it("every pin's committed manifest copy is one of its mapped paths", () => {
    for (const pin of pins.manifests) {
      expect(map.pins[pin.id]).toContain(
        `tests/e2e/design/conformance/manifests/${pin.file}`,
      );
    }
  });

  it("every pin maps the shared driver and EVERY harness file that mounts one of its surfaces", () => {
    // Derived independently of the map, from the manifest's own surface ids:
    // whichever fixture file renders `data-surface-id="<id>"` consumes that
    // manifest. A map that keeps only the manifest path for a pin (the
    // obvious weakening) fails here, because changes to the dropped consumer
    // would then only warn instead of redding the pin they adopt.
    const HARNESS_ROOT = path.join(REPO_ROOT, "src/app/design-fixtures/conformance");
    const walk = (dir) =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? walk(path.join(dir, e.name))
          : [path.join(dir, e.name)],
      );
    const harnessFiles = walk(HARNESS_ROOT);
    for (const pin of pins.manifests) {
      const manifest = JSON.parse(
        readFileSync(
          path.join(REPO_ROOT, "tests/e2e/design/conformance/manifests", pin.file),
          "utf8",
        ),
      );
      const owners = new Set();
      for (const surface of manifest.surfaces) {
        for (const file of harnessFiles) {
          if (readFileSync(file, "utf8").includes(`data-surface-id="${surface.id}"`)) {
            owners.add(path.relative(REPO_ROOT, file));
          }
        }
      }
      expect(owners.size, `${pin.id} declares surfaces no harness file mounts`).toBeGreaterThan(0);
      for (const owner of owners) {
        expect(map.pins[pin.id], `${pin.id} does not map its consumer ${owner}`).toContain(owner);
      }
      expect(
        map.pins[pin.id],
        `${pin.id} does not map the shared conformance driver`,
      ).toContain("tests/e2e/design/conformance/contract.ts");
    }
  });

  it("the workflow resolves a merge group against the event's own base_sha", () => {
    // origin/main can move under a queued group; the baseline that decides
    // which pins a merge group adopts is the event's base_sha.
    const workflow = readFileSync(path.join(REPO_ROOT, WORKFLOW_PATH), "utf8");
    const job = workflow.slice(workflow.indexOf("  design-pin-drift:"));
    expect(job).toContain("github.event.merge_group.base_sha");
    expect(job).toContain("DESIGN_PIN_DRIFT_DIFF_BASE");
  });
});

// ---------------------------------------------------------------------------
// Criterion 2 — the CLI wiring itself (the parts a pure-function test misses)
// ---------------------------------------------------------------------------

/** Runs the real CLI body with the fetch, git and streams injected. */
async function cli({ argv = [], env = {}, fetchManifest, gitOut = {} } = {}) {
  const out = [];
  const err = [];
  const gitCalls = [];
  const runGit = (args) => {
    gitCalls.push(args);
    const key = args[0];
    if (key === "merge-base") return gitOut.mergeBase ?? "";
    if (key === "rev-parse") {
      if (gitOut.unresolvable) throw new Error("bad revision");
      return "";
    }
    if (key === "diff") {
      // The per-file, zero-context diff the driver-file attribution reads.
      if (args.includes("--unified=0")) return gitOut.driverDiff ?? "";
      return (gitOut.touched ?? []).join("\n");
    }
    if (key === "show") {
      const target = String(args[1] ?? "");
      if (target.endsWith(MAP_PATH)) {
        return gitOut.baseMapFile ?? readFileSync(path.join(REPO_ROOT, MAP_PATH), "utf8");
      }
      if (target.endsWith(DRIVER_FILE_PATH)) {
        return (
          gitOut.baseDriverFile ?? readFileSync(path.join(REPO_ROOT, DRIVER_FILE_PATH), "utf8")
        );
      }
      return gitOut.basePinFile ?? readFileSync(path.join(REPO_ROOT, PINS_PATH), "utf8");
    }
    return "";
  };
  const exitCode = await runCli({
    argv,
    env,
    fetchManifest: fetchManifest ?? fixtureFetcher(SUPERSEDED),
    runGit,
    log: (line) => out.push(String(line)),
    logError: (line) => err.push(String(line)),
  });
  return { exitCode, out: out.join("\n"), err: err.join("\n"), gitCalls };
}

describe("criterion 2 — the CLI turns that rule into a diff, an annotation and an exit code", () => {
  it("diffs the branch against its merge base with the resolved base (three dots)", async () => {
    const run = await cli({
      env: { GITHUB_EVENT_NAME: "pull_request", DESIGN_PIN_DRIFT_DIFF_BASE: "origin/main" },
      gitOut: { touched: ["src/lib/unrelated.ts"] },
    });
    const diffCall = run.gitCalls.find((args) => args[0] === "diff");
    // A two-dot diff, or a HEAD self-compare, reports the wrong file set and
    // is the fail-OPEN direction: pins nobody is shown to adopt only warn.
    expect(diffCall).toEqual(["diff", "--name-only", "origin/main...HEAD"]);
  });

  it("exits 0 with a warning annotation per drifted pin when the diff adopts none of them", async () => {
    const run = await cli({
      argv: ["--github-annotations"],
      env: { GITHUB_EVENT_NAME: "pull_request", DESIGN_PIN_DRIFT_DIFF_BASE: "origin/main" },
      gitOut: { touched: ["src/lib/unrelated.ts", "README.md"] },
    });
    expect(run.exitCode).toBe(0);
    expect(run.err).toBe("");
    for (const id of ALL_IDS) {
      expect(run.out, id).toContain(`::warning title=design-pin-drift: ${id} (drift)::`);
    }
    expect(run.out.match(/^::error/m)).toBeNull();
    expect(run.out).toContain("ok (warnings only)");
  });

  it("exits 1 with an error annotation naming ONLY the adopted pin", async () => {
    const run = await cli({
      argv: ["--github-annotations"],
      env: { GITHUB_EVENT_NAME: "pull_request", DESIGN_PIN_DRIFT_DIFF_BASE: "origin/main" },
      gitOut: { touched: [map.pins["app-connectors"][0]] },
    });
    expect(run.exitCode).toBe(1);
    expect(run.out).toContain("::error title=design-pin-drift: app-connectors::");
    expect(run.out).not.toContain("::warning title=design-pin-drift: app-connectors");
    expect(run.err).toContain('DRIFT — pin "app-connectors"');
    expect(run.err).toContain(MOVE_RULE);
  });

  it("exits 1 for every pin on a main push, whatever the diff touched", async () => {
    const run = await cli({ env: { GITHUB_EVENT_NAME: "push", GITHUB_REF_NAME: "main" } });
    expect(run.exitCode).toBe(1);
    for (const id of ALL_IDS) expect(run.err, id).toContain(`pin "${id}"`);
    // No diff is taken at all on that arm: every pin is red regardless.
    expect(run.gitCalls.find((args) => args[0] === "diff")).toBeUndefined();
  });

  it("treats an absent diff base as every pin touched (fail-closed), not as an empty diff", async () => {
    const run = await cli({ env: { GITHUB_EVENT_NAME: "pull_request" } });
    expect(run.exitCode).toBe(1);
    expect(run.out).toContain("::notice::DESIGN_PIN_DRIFT_DIFF_BASE is not set");
    for (const id of ALL_IDS) expect(run.err, id).toContain(`pin "${id}"`);
  });

  it("exits 2 rather than diffing against nothing when the base does not resolve", async () => {
    const run = await cli({
      env: { GITHUB_EVENT_NAME: "pull_request", DESIGN_PIN_DRIFT_DIFF_BASE: "origin/gone" },
      gitOut: { unresolvable: true },
    });
    expect(run.exitCode).toBe(2);
    expect(run.err).toContain("does not resolve to a commit");
    expect(run.gitCalls.find((args) => args[0] === "diff")).toBeUndefined();
  });

  it("exits 0 with no annotation at all when every published manifest matches", async () => {
    const run = await cli({
      argv: ["--github-annotations"],
      env: { GITHUB_EVENT_NAME: "push", GITHUB_REF_NAME: "main" },
      fetchManifest: fixtureFetcher((file) => ({
        body: readFileSync(path.join(REPO_ROOT, "tests/e2e/design/conformance/manifests", file)),
      })),
    });
    expect(run.exitCode).toBe(0);
    expect(run.out).not.toContain("::error");
    expect(run.out).not.toContain("::warning");
    expect(run.out).toContain("ok: all 5 published conformance manifests match their pins.");
  });
});

// ---------------------------------------------------------------------------
// cinatra#3421 — a file EVERY pin shares is attributed per pin
// ---------------------------------------------------------------------------

describe("cinatra#3421 — a shared-file touch is attributed per pin, not to every pin", () => {
  const DRIVER_FILE = "tests/e2e/design/conformance/contract.ts";
  const driverLines = readFileSync(path.join(REPO_ROOT, DRIVER_FILE), "utf8").split("\n");
  const PR = { GITHUB_EVENT_NAME: "pull_request", DESIGN_PIN_DRIFT_DIFF_BASE: "origin/main" };

  /** The 1-based line a named top-level declaration of the driver file opens on. */
  const declarationLine = (declaration) => {
    const index = driverLines.findIndex((line) => line.startsWith(declaration));
    expect(index, `${declaration} is not a top-level declaration of ${DRIVER_FILE}`).toBeGreaterThan(-1);
    return index + 1;
  };
  /** One changed line, in the shape `git diff --unified=0` reports it. */
  const hunkAt = (line) => `diff --git a/${DRIVER_FILE} b/${DRIVER_FILE}\n@@ -${line},1 +${line},1 @@\n-was\n+is\n`;
  const otherThan = (id) => ALL_IDS.filter((other) => other !== id);

  it("a diff touching only the app-connectors entry of the pin MAP is red on app-connectors alone", async () => {
    // The map is shared by all five pins, and it used to be a global path: a
    // one-entry map edit read as every pin, so the PR adopting app-connectors
    // went red on the four drifts it did not touch.
    const head = JSON.parse(readFileSync(path.join(REPO_ROOT, MAP_PATH), "utf8"));
    const base = {
      ...head,
      pins: { ...head.pins, "app-connectors": head.pins["app-connectors"].slice(0, -1) },
    };
    const run = await cli({
      argv: ["--github-annotations"],
      env: PR,
      gitOut: { touched: [MAP_PATH], baseMapFile: JSON.stringify(base, null, 2) },
    });
    expect(run.exitCode).toBe(1);
    expect(run.err).toContain('DRIFT — pin "app-connectors"');
    for (const id of otherThan("app-connectors")) {
      expect(run.err, id).not.toContain(`pin "${id}"`);
      expect(run.out, id).toContain(`::warning title=design-pin-drift: ${id} (drift)::`);
    }
  });

  it("a diff touching a DRIVER BLOCK mapped to one pin is red on that pin alone", async () => {
    // CONNECTOR_SETUP_DRIVER is what the surface-to-driver table binds
    // "connector-setup" to, and app-connectors is the only pin whose manifest
    // declares that surface.
    const run = await cli({
      argv: ["--github-annotations"],
      env: PR,
      gitOut: {
        touched: [DRIVER_FILE],
        driverDiff: hunkAt(declarationLine("const CONNECTOR_SETUP_DRIVER") + 2),
      },
    });
    expect(run.exitCode).toBe(1);
    expect(run.err).toContain('DRIFT — pin "app-connectors"');
    for (const id of otherThan("app-connectors")) {
      expect(run.err, id).not.toContain(`pin "${id}"`);
      expect(run.out, id).toContain(`::warning title=design-pin-drift: ${id} (drift)::`);
    }
  });

  it("a diff touching a SHARED HELPER outside every driver block is red on no pin", async () => {
    // The seed helper drives no surface: it is the case that red every
    // drifting pin at once and blocked the adoptions from ever going green.
    const run = await cli({
      argv: ["--github-annotations"],
      env: PR,
      gitOut: {
        touched: [DRIVER_FILE],
        driverDiff: hunkAt(declarationLine("export function ensureSeeded") + 1),
      },
    });
    expect(run.exitCode).toBe(0);
    expect(run.err).toBe("");
    expect(run.out).toContain("ok (warnings only)");
    for (const id of ALL_IDS) {
      expect(run.out, id).toContain(`::warning title=design-pin-drift: ${id} (drift)::`);
    }
  });

  it("the CHECKER and the workflow still touch every pin, and an unreadable shared file still does", () => {
    expect(GLOBAL_PATHS).toEqual([CHECKER_PATH, WORKFLOW_PATH]);
    for (const global of [CHECKER_PATH, WORKFLOW_PATH]) {
      expect(resolveTouchedPinIds({ touchedPaths: [global], map }), global).toEqual(ALL_IDS);
    }
    // Fail-closed, unchanged: a shared file whose changed part cannot be
    // determined is every id, exactly as the pin file already answered.
    expect(resolveTouchedPinIds({ touchedPaths: [MAP_PATH], map })).toEqual(ALL_IDS);
    expect(resolveTouchedPinIds({ touchedPaths: [DRIVER_FILE], map })).toEqual(ALL_IDS);
    expect(
      resolveTouchedPinIds({ touchedPaths: [DRIVER_FILE], map, driverPinIds: [] }),
    ).toEqual([]);
  });

  it("the driver-file constant names the file every pin maps as its driver", () => {
    expect(DRIVER_FILE_PATH).toBe(DRIVER_FILE);
    for (const id of ALL_IDS) expect(map.pins[id], id).toContain(DRIVER_FILE_PATH);
    // The manifests are the ground truth for which surfaces a pin owns.
    const surfaces = loadPinSurfaceIds(map, REPO_ROOT);
    expect(surfaces["app-connectors"]).toContain("connector-setup");
    expect(surfaces["app-notifications"]).not.toContain("connector-setup");
  });

  it("changedMapPinIdsBetween names the entries that moved, and a moved rule moves every pin", () => {
    const head = JSON.parse(readFileSync(path.join(REPO_ROOT, MAP_PATH), "utf8"));
    const text = (o) => JSON.stringify(o);
    const mapIds = Object.keys(head.pins);

    expect(changedMapPinIdsBetween(text(head), text(head))).toEqual([]);
    expect(changedMapPinIdsBetween(text(head), text({ ...head, $comment: "reworded" }))).toEqual([]);

    const oneEntry = {
      ...head,
      pins: { ...head.pins, "app-connectors": [...head.pins["app-connectors"], "src/app/x.tsx"] },
    };
    expect(changedMapPinIdsBetween(text(head), text(oneEntry))).toEqual(["app-connectors"]);

    // globalPaths and the pin list decide what the gate READS, not what one
    // pin adopts: both answer with every id, so no map edit narrows the rule.
    const moved = { ...head, globalPaths: [CHECKER_PATH] };
    expect(changedMapPinIdsBetween(text(head), text(moved))).toEqual(mapIds);
    const dropped = { ...head, pins: Object.fromEntries(Object.entries(head.pins).slice(1)) };
    expect(changedMapPinIdsBetween(text(head), text(dropped))).toEqual(mapIds);
  });

  it("parseChangedLineRanges reads every hunk shape git writes at zero context", () => {
    expect(parseChangedLineRanges("@@ -10,3 +12,4 @@ context\n")).toEqual([{ start: 12, end: 15 }]);
    expect(parseChangedLineRanges("@@ -10 +12 @@\n")).toEqual([{ start: 12, end: 12 }]);
    // A pure deletion names the position the removed lines sat BETWEEN, so
    // both sides of the cut answer for it.
    expect(parseChangedLineRanges("@@ -10,2 +9,0 @@\n")).toEqual([{ start: 9, end: 10 }]);
    expect(parseChangedLineRanges("no hunk here")).toEqual([]);
  });

  it("driverBlocks cuts the REAL driver file into ordered, non-overlapping blocks", () => {
    const blocks = driverBlocks(readFileSync(path.join(REPO_ROOT, DRIVER_FILE), "utf8"));
    expect(blocks.length).toBeGreaterThan(50);
    for (let i = 1; i < blocks.length; i += 1) {
      expect(blocks[i].start, blocks[i].name).toBeGreaterThan(blocks[i - 1].start);
      expect(blocks[i].start, blocks[i].name).toBeGreaterThan(blocks[i - 1].end - 1);
    }
    const named = (name) => blocks.find((block) => block.name === name);
    const setup = named("CONNECTOR_SETUP_DRIVER");
    const seed = named("ensureSeeded");
    expect(setup, "the connector-setup driver is a block of its own").toBeDefined();
    expect(seed, "the seed helper is a block of its own").toBeDefined();
    const setupDeclaration = declarationLine("const CONNECTOR_SETUP_DRIVER");
    expect(setup.start).toBeLessThanOrEqual(setupDeclaration);
    expect(setup.end).toBeGreaterThan(setupDeclaration);
    expect(seed.end).toBeLessThan(setup.start);
  });

  it("driverFilePinIds gives the three answers the rule names, and nothing else", () => {
    // A driver file in miniature, with the same structure the real one has.
    const synthetic = [
      'import { expect } from "@playwright/test";', // 1
      "", // 2
      "/** A helper every family uses. */", // 3
      "export function ensureSeeded(): Promise<void> {", // 4
      "  return Promise.resolve();", // 5
      "}", // 6
      "", // 7
      "const ALPHA_DRIVER: SurfaceDriver = {", // 8
      '  mount: "alpha",', // 9
      "};", // 10
      "", // 11
      "function familyDriver(row) {", // 12
      "  return { mount: row.mount };", // 13
      "}", // 14
      "", // 15
      "export const SURFACE_DRIVERS: Record<string, SurfaceDriver> = {", // 16
      '  "alpha-surface": ALPHA_DRIVER,', // 17
      "  ...Object.fromEntries(ROWS.map((row) => [row.id, familyDriver(row)])),", // 18
      "};", // 19
    ].join("\n");
    const pinSurfaceIds = { "pin-one": ["alpha-surface"], "pin-two": ["beta-surface"] };
    const allIds = ["pin-one", "pin-two"];
    const answer = (line) =>
      driverFilePinIds({
        contractText: synthetic,
        baseContractText: synthetic,
        diffText: `@@ -${line},1 +${line},1 @@\n-was\n+is\n`,
        pinSurfaceIds,
        allIds,
      });

    // 1. a block the table binds to a pinned surface -> that pin;
    expect(answer(9)).toEqual(["pin-one"]);
    expect(answer(17)).toEqual(["pin-one"]);
    // 2. a shared helper the table never names -> no pin;
    expect(answer(5)).toEqual([]);
    // 3. a family factory the table reaches only through a computed entry,
    //    and the table's own lines -> every pin, fail-closed.
    expect(answer(13)).toEqual(allIds);
    expect(answer(18)).toEqual(allIds);
    expect(answer(19)).toEqual(allIds);
    // An empty diff adopts nothing; an unreadable file adopts everything.
    expect(
      driverFilePinIds({
        contractText: synthetic,
        baseContractText: synthetic,
        diffText: "",
        pinSurfaceIds,
        allIds,
      }),
    ).toEqual([]);
    expect(
      driverFilePinIds({
        contractText: "const NOTHING = 1;\n",
        diffText: "@@ -1,1 +1,1 @@\n",
        pinSurfaceIds,
        allIds,
      }),
    ).toEqual(allIds);
  });

  // Convergence round (cinatra#3421): three ways a head-only reader loses the
  // pin that owns a change, each fail-OPEN — the pin is never asked.
  it("attributes a DELETED line by the base file, not by the lines that closed over it", () => {
    const base = [
      'const ALPHA_DRIVER: SurfaceDriver = { mount: "alpha" };', // 1
      'const BETA_DRIVER: SurfaceDriver = { mount: "beta" };', // 2
      "export const SURFACE_DRIVERS: Record<string, SurfaceDriver> = {", // 3
      '  "alpha-surface": ALPHA_DRIVER,', // 4
      '  "beta-surface": BETA_DRIVER,', // 5
      "};", // 6
    ].join("\n");
    // The alpha driver is DELETED: on the head side nothing sits in its block
    // any more, and the head line the hunk names is the beta driver that
    // closed over the gap. Only the base file can say the cut was pin-one's.
    const head = base.split("\n").slice(1).join("\n");
    const diffText = '@@ -1,1 +0,0 @@\n-const ALPHA_DRIVER: SurfaceDriver = { mount: "alpha" };\n';
    const pinSurfaceIds = { "pin-one": ["alpha-surface"], "pin-two": ["beta-surface"] };
    const allIds = ["pin-one", "pin-two"];
    const answer = driverFilePinIds({
      contractText: head,
      baseContractText: base,
      diffText,
      pinSurfaceIds,
      allIds,
    });
    // A head-only reader answers "pin-two" alone here: the pin that OWNED the
    // deleted block is never asked (fail-open).
    expect(answer).toContain("pin-one");
    // Without the base side the removal cannot be placed at all: every id.
    expect(
      driverFilePinIds({ contractText: head, diffText, pinSurfaceIds, allIds }),
    ).toEqual(allIds);
  });

  it("answers every pin when the driver file's structure or the diff cannot be read", () => {
    const pinSurfaceIds = { "pin-one": ["alpha-surface"] };
    const allIds = ["pin-one", "pin-two"];
    // A declaration keyword alone on its line is a block boundary this reader
    // cannot see; its body would otherwise fall into the block above it.
    const dangling = [
      "const",
      '  ALPHA_DRIVER: SurfaceDriver = { mount: "alpha" };',
      "export const SURFACE_DRIVERS: Record<string, SurfaceDriver> = {",
      '  "alpha-surface": ALPHA_DRIVER,',
      "};",
    ].join("\n");
    expect(
      driverFilePinIds({
        contractText: dangling,
        baseContractText: dangling,
        diffText: "@@ -2,1 +2,1 @@\n-was\n+is\n",
        pinSurfaceIds,
        allIds,
      }),
    ).toEqual(allIds);
    // Diff output that carries no hunk at all still reports a CHANGED file.
    expect(
      driverFilePinIds({
        contractText: dangling,
        baseContractText: dangling,
        diffText: "diff --git a/contract.ts b/contract.ts\nBinary files a/x and b/x differ\n",
        pinSurfaceIds,
        allIds,
      }),
    ).toEqual(allIds);
  });

  it("parseRemovedLineRanges reads the BASE side of every hunk shape", () => {
    expect(parseRemovedLineRanges("@@ -10,3 +12,4 @@ context\n")).toEqual([{ start: 10, end: 12 }]);
    expect(parseRemovedLineRanges("@@ -10 +12 @@\n")).toEqual([{ start: 10, end: 10 }]);
    // A pure addition removes nothing and owns no base-side line.
    expect(parseRemovedLineRanges("@@ -10,0 +11,2 @@\n")).toEqual([]);
    expect(parseRemovedLineRanges("no hunk here")).toEqual([]);
  });

  it("reads every base-side file at the MERGE BASE the path diff already uses", async () => {
    const run = await cli({
      env: PR,
      gitOut: { touched: [MAP_PATH], mergeBase: "abc1234" },
    });
    const show = run.gitCalls.find((args) => args[0] === "show");
    // `git show origin/main:<map>` would read the TARGET TIP: an entry the
    // target moved after the branch cut would read as this branch's adoption.
    expect(show).toEqual(["show", `abc1234:${MAP_PATH}`]);
    expect(run.gitCalls.find((args) => args[0] === "merge-base")).toEqual([
      "merge-base",
      "origin/main",
      "HEAD",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Criterion 3 — pin-file hygiene
// ---------------------------------------------------------------------------

describe("criterion 3 — the pin file carries no provenance key", () => {
  it("the REAL conformance-pins.json passes the structural check", () => {
    const report = checkPinsStructure(pins);
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("no pin entry carries $specCommit or any other key beyond the five", () => {
    const raw = readFileSync(path.join(REPO_ROOT, PINS_PATH), "utf8");
    expect(raw).not.toContain("$specCommit");
    for (const pin of pins.manifests) {
      expect(Object.keys(pin).sort(), pin.id).toEqual([...PIN_ENTRY_KEYS].sort());
    }
  });

  it("the structural check REFUSES a fixture pin carrying $specCommit", () => {
    const tampered = {
      ...pins,
      manifests: [{ ...pins.manifests[0], $specCommit: "a free-text upstream note" }],
    };
    const report = checkPinsStructure(tampered);
    expect(report.ok).toBe(false);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0].pin).toBe(pins.manifests[0].id);
    expect(report.errors[0].message).toContain("$specCommit");
  });

  it("the structural check refuses ANY unknown key, not just $specCommit", () => {
    for (const key of ["specCommit", "upstreamRef", "$note", "provenance"]) {
      const tampered = {
        ...pins,
        manifests: [{ ...pins.manifests[0], [key]: "x" }],
      };
      const report = checkPinsStructure(tampered);
      expect(report.ok, key).toBe(false);
      expect(report.errors[0].message, key).toContain(key);
    }
  });

  it("the structural check refuses a hash that is not lowercase 64-hex", () => {
    const bad = [
      ["manifestSha256", "023C1B130DD695306BBF31C2199663FC3A4C01CB48D2F3453F6BFA9F9ABA64A9"],
      ["manifestSha256", "sha256:023c1b130dd695306bbf31c2199663fc3a4c01cb48d2f3453f6bfa9f9aba64a9"],
      ["manifestSha256", "023c1b13"],
      ["specContentHash", "b1ea506e3f3e5884865a524a3c01a518da7af69c20a48a68919d5164613e6d8e"],
      ["specContentHash", "sha256:B1EA506E3F3E5884865A524A3C01A518DA7AF69C20A48A68919D5164613E6D8E"],
    ];
    for (const [key, value] of bad) {
      const report = checkPinsStructure({
        ...pins,
        manifests: [{ ...pins.manifests[0], [key]: value }],
      });
      expect(report.ok, `${key}=${value}`).toBe(false);
      expect(report.errors[0].message, `${key}=${value}`).toContain(key);
    }
  });

  it("the structural check refuses an unknown source and a duplicate id", () => {
    expect(
      checkPinsStructure({
        ...pins,
        manifests: [{ ...pins.manifests[0], source: "upstream" }],
      }).ok,
    ).toBe(false);
    expect(
      checkPinsStructure({
        ...pins,
        manifests: [pins.manifests[0], { ...pins.manifests[0] }],
      }).ok,
    ).toBe(false);
  });

  it("the structural check accepts the top-level pinning-contract comment but no top-level extra", () => {
    expect(checkPinsStructure({ ...pins, $comment: "the pinning contract" }).ok).toBe(true);
    expect(checkPinsStructure({ ...pins, $upstream: "anything" }).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Criterion 4 — the red message
// ---------------------------------------------------------------------------

describe("criterion 4 — the red message says exactly what it must, and nothing else", () => {
  let message;
  let results;

  it("names the pin id, file, published URL, both hash pairs, the outcome and the rule", async () => {
    results = await runCheck({ pins, fetchManifest: fixtureFetcher(SUPERSEDED) });
    const failing = [byId(results, "app-components")];
    message = formatRedMessage(failing);

    expect(message).toContain("app-components");
    expect(message).toContain("app-components.json");
    expect(message).toContain(
      "https://docs.cinatra.ai/references/design/conformance/app-components.json",
    );
    expect(message).toContain(
      "023c1b130dd695306bbf31c2199663fc3a4c01cb48d2f3453f6bfa9f9aba64a9",
    );
    expect(message).toContain(
      "ddfcd50b57cea849063d6bb067c3a710169b5f48282154b6397f3ba1f6de9928",
    );
    expect(message).toContain(
      "sha256:b1ea506e3f3e5884865a524a3c01a518da7af69c20a48a68919d5164613e6d8e",
    );
    expect(message).toContain(
      "sha256:a265d1b3e7a7e24681604659d88f91d503a65dad8e028f2069ab65d728b6acaf",
    );
    expect(message).toContain("drift");
    expect(message).toContain(MOVE_RULE);
    expect(MOVE_RULE).toContain("hash-only re-pin");
  });

  it("says NOTHING about the upstream source beyond the published URL", () => {
    // A hash mismatch proves DIFFERENT, not BEHIND: the public gate may not
    // name an upstream commit, repository or spec path, and there is no
    // provenance field left for it to read one from.
    expect(message).not.toMatch(/(?<![0-9a-f])[0-9a-f]{40}(?![0-9a-f])/);
    expect(message.toLowerCase()).not.toContain("commit");
    expect(message.toLowerCase()).not.toContain("upstream");
    expect(message).not.toContain("specs/");
    expect(message).not.toContain("$specCommit");
    expect(message).not.toContain("@");
  });

  it("names each non-match outcome in its own message", async () => {
    const cases = [
      [
        "http-failure",
        async () => ({ ok: false, status: 503, body: Buffer.from("") }),
        ["503", "(not read)"],
      ],
      [
        "invalid-json",
        fixtureFetcher(() => ({ body: readFileSync(path.join(MALFORMED, "http-error-page.html")) })),
        ["does not parse as JSON"],
      ],
      [
        "schema-failure",
        fixtureFetcher(() => ({
          body: readFileSync(path.join(MALFORMED, "schema-version-unsupported.json")),
        })),
        ['schemaVersion is not "1.0.0"'],
      ],
    ];
    for (const [outcome, fetchManifest, mustContain] of cases) {
      const results = await runCheck({ pins, fetchManifest });
      const text = formatRedMessage([byId(results, "app")]);
      expect(text, outcome).toContain(outcome);
      for (const fragment of mustContain) expect(text, `${outcome}: ${fragment}`).toContain(fragment);
      // Same negative bound as the drift message.
      expect(text, outcome).not.toContain("specs/");
      expect(text, outcome).not.toContain("<html");
    }
  });

  it("never echoes a fetched body back into its output", async () => {
    // The published body is remote input. A gate that prints remote input can
    // be made to print anything, including a path it must never name.
    const planted = "specs/never-print-this.html";
    const results = await runCheck({
      pins,
      fetchManifest: async () => ({
        ok: true,
        status: 200,
        body: Buffer.from(JSON.stringify({ schemaVersion: planted, contentHash: planted })),
      }),
    });
    expect(outcomesOf(results)).toEqual(Array(5).fill("schema-failure"));
    const text = formatRedMessage(results);
    expect(text).not.toContain(planted);
    expect(text).not.toContain("never-print-this");
    expect(formatTable(results)).not.toContain("never-print-this");
  });

  it("prints a per-pin table of id, file, both hashes and the outcome", async () => {
    const results = await runCheck({ pins, fetchManifest: fixtureFetcher(SUPERSEDED) });
    const table = formatTable(results);
    const lines = table.split("\n");
    expect(lines[0]).toContain("pin");
    expect(lines[0]).toContain("outcome");
    expect(lines).toHaveLength(2 + results.length);
    const bare = (hash) => hash.replace(/^sha256:/, "").slice(0, 12);
    for (const r of results) {
      const row = lines.find((l) => l.startsWith(r.id));
      expect(row, r.id).toContain(r.file);
      // BOTH compared pairs, not just the byte hash: the table is the summary
      // a reader sees first, and a contentHash-only drift must be visible in
      // it. All four values differ per pin, so no column can stand in for
      // another.
      expect(row, r.id).toContain(bare(r.pinnedManifestSha256));
      expect(row, r.id).toContain(bare(r.publishedManifestSha256));
      expect(row, r.id).toContain(bare(r.pinnedSpecContentHash));
      expect(row, r.id).toContain(bare(r.publishedSpecContentHash));
      expect(row, r.id).toContain("drift");
    }
    expect(lines[0]).toContain("pinned-content");
    expect(lines[0]).toContain("published-content");
  });

  it("a contentHash-only drift is visible in the table, not only in the red block", async () => {
    // The mutation this catches: dropping the content columns. The bytes of
    // this body hash to what the pin names for them, so ONLY the content
    // columns can carry the evidence.
    const pin = pins.manifests[0];
    const tampered = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "tests/e2e/design/conformance/manifests", pin.file), "utf8"),
    );
    tampered.contentHash = `sha256:${"c".repeat(64)}`;
    const body = Buffer.from(JSON.stringify(tampered));
    const repinned = {
      ...pins,
      manifests: [{ ...pin, manifestSha256: createHash("sha256").update(body).digest("hex") }],
    };
    const results = await runCheck({
      pins: repinned,
      fetchManifest: async () => ({ ok: true, status: 200, body }),
    });
    expect(outcomesOf(results)).toEqual(["drift"]);
    const row = formatTable(results).split("\n").find((l) => l.startsWith(pin.id));
    expect(row).toContain("c".repeat(12));
  });
});

// ---------------------------------------------------------------------------
// Criterion 5/6 — the checker's own constants stay honest
// ---------------------------------------------------------------------------

describe("criteria 5 and 6 — the constants the docs page and the follow-up depend on", () => {
  it("the checker, map and workflow constants name real paths", () => {
    for (const p of [CHECKER_PATH, MAP_PATH, WORKFLOW_PATH, PINS_PATH]) {
      expect(() => readFileSync(path.join(REPO_ROOT, p)), p).not.toThrow();
    }
  });

  it("the docs page exists and covers every topic criterion 5 names", () => {
    const doc = readFileSync(
      path.join(REPO_ROOT, "docs/internals/contracts/design-conformance-pin-drift.md"),
      "utf8",
    );
    for (const heading of [
      "## What the job checks",
      "## The trigger rule",
      "## Who moves a pin",
      "## Why a hash-only re-pin is refused",
      "## Rollout state",
      "## Known drifts",
      // The page keeps the record the "who moves a pin" rule demands: what
      // each adoption changed, named per pin, in the same place the drift was
      // recorded before it.
      "## Reconciliation record",
    ]) {
      expect(doc, heading).toContain(heading);
    }
    for (const id of ALL_IDS) expect(doc, id).toContain(id);
    // Every surface the reconciliation moved is named on the page, so the
    // record cannot go quiet about the expensive half of the adoption.
    for (const surface of [
      "sidebar-assistants-entry",
      "scheduling-trigger-tab",
      "scheduling-step-configured",
      "breadcrumb-entity-resolution",
    ]) {
      expect(doc, surface).toContain(surface);
    }
  });

  it("rollout step (b): the branch-protection contexts list design-pin-drift", () => {
    const protections = JSON.parse(
      readFileSync(path.join(REPO_ROOT, ".github/branch-protections.json"), "utf8"),
    );
    expect(protections.required_status_checks.contexts).toContain("design-pin-drift");
  });
});
