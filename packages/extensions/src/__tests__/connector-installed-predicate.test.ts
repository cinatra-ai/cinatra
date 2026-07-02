// CG-1 regression guard (cinatra#657, Phase-A keystone).
//
// The connector "installed" predicate is being DEMOTED from "own-key membership
// in STATIC_EXTENSION_MANIFEST" to "a live canonical installed_extension row for
// the actor's scope, FALLING BACK to the bundled static manifest". This test
// locks the load-bearing CG-1 invariant directly on the pure decision function so
// it runs in CI (`packages/extensions` `test:invariants` is an EXPLICIT file
// list; host-side `src/lib/__tests__` unit tests are NOT executed by any CI job).
//
// The three booleans this function receives are produced by the host wrapper:
//   - hasAddressableLiveCanonicalRowForActor = pickActiveInstallId(rows, actor) !== null
//     (a live active|locked addressable row; fail-closed on cross-org/owner-less).
//   - hasAddressableCanonicalRowForActor = some row addressable by the actor,
//     status-AGNOSTIC (distinguishes a legitimate "no row" from an explicit archive).
//   - bundledInStaticManifest = Object.hasOwn(STATIC_EXTENSION_MANIFEST, pkg).

import { describe, expect, it } from "vitest";

import { isConnectorInstalledFromRuntime } from "../connector-installed-predicate";

describe("isConnectorInstalledFromRuntime (CG-1: bundled fallback + runtime fail-closed)", () => {
  it("FRESH INSTANCE: a bundled connector with NO addressable row is still installed", () => {
    // The boot seeder anchors a canonical row only for bundled serverEntry OR
    // required-in-prod packages, so a bundled schema-config connector that is
    // neither has NO row on a fresh instance. The static manifest is the bundled
    // fallback — it must NOT be blanked.
    expect(
      isConnectorInstalledFromRuntime({
        hasAddressableLiveCanonicalRowForActor: false,
        hasAddressableCanonicalRowForActor: false,
        bundledInStaticManifest: true,
      }),
    ).toBe(true);
  });

  it("RUNTIME-INSTALLED: a connector with a live row but NO bundled entry is installed", () => {
    // A purely marketplace/runtime-installed connector has no static-manifest
    // entry (the manifest only covers the base-image bundle) — the live canonical
    // row is now the source of truth.
    expect(
      isConnectorInstalledFromRuntime({
        hasAddressableLiveCanonicalRowForActor: true,
        hasAddressableCanonicalRowForActor: true,
        bundledInStaticManifest: false,
      }),
    ).toBe(true);
  });

  it("RUNTIME-ABSENT: no addressable row + NO bundled entry is NOT installed", () => {
    // No addressable row at all (uninstalled / cross-org / owner-less) and no
    // bundled fallback → fail closed.
    expect(
      isConnectorInstalledFromRuntime({
        hasAddressableLiveCanonicalRowForActor: false,
        hasAddressableCanonicalRowForActor: false,
        bundledInStaticManifest: false,
      }),
    ).toBe(false);
  });

  it("RUNTIME-ARCHIVED bundled connector: an explicit operator disable HIDES it", () => {
    // A bundled connector with an addressable ARCHIVED row was explicitly disabled
    // — the bundled fallback must NOT resurrect a torn-down surface. This is the
    // load-bearing distinction between "legitimately no row" and "archived".
    expect(
      isConnectorInstalledFromRuntime({
        hasAddressableLiveCanonicalRowForActor: false,
        hasAddressableCanonicalRowForActor: true,
        bundledInStaticManifest: true,
      }),
    ).toBe(false);
  });

  it("RUNTIME-ARCHIVED runtime-only connector: hidden (no bundled fallback either)", () => {
    expect(
      isConnectorInstalledFromRuntime({
        hasAddressableLiveCanonicalRowForActor: false,
        hasAddressableCanonicalRowForActor: true,
        bundledInStaticManifest: false,
      }),
    ).toBe(false);
  });

  it("BOTH: a bundled connector that ALSO has a live runtime row is installed", () => {
    expect(
      isConnectorInstalledFromRuntime({
        hasAddressableLiveCanonicalRowForActor: true,
        hasAddressableCanonicalRowForActor: true,
        bundledInStaticManifest: true,
      }),
    ).toBe(true);
  });

  it("STORE-OUTAGE for a bundled connector: bundled fallback keeps it visible", () => {
    // On a canonical-store read failure the host wrapper passes BOTH addressable
    // flags `false` (it never invents a row); a bundled connector survives because
    // the static manifest is in-image.
    expect(
      isConnectorInstalledFromRuntime({
        hasAddressableLiveCanonicalRowForActor: false,
        hasAddressableCanonicalRowForActor: false,
        bundledInStaticManifest: true,
      }),
    ).toBe(true);
  });

  it("STORE-OUTAGE for a runtime-only connector: fail-closed (cannot prove installed)", () => {
    // A purely runtime-installed connector cannot be proven installed during a
    // store outage and has no bundled fallback → it fails closed. We never invent
    // a row to keep it visible.
    expect(
      isConnectorInstalledFromRuntime({
        hasAddressableLiveCanonicalRowForActor: false,
        hasAddressableCanonicalRowForActor: false,
        bundledInStaticManifest: false,
      }),
    ).toBe(false);
  });
});
