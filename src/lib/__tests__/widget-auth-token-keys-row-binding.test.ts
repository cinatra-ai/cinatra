// Owner ruling 2026-07-23 (widget-auth delivery fix, path B) — the widget-auth
// token-keys canonical write is BOUND to the SAME row the install's provenance
// binds. A non-default SIDE-BY-SIDE install (boundRowId) must write to ITS OWN
// row, never clobber the DEFAULT row's declaration (the row arm (c) resolves).

import { describe, it, expect, vi, beforeEach } from "vitest";

const recordExtensionWidgetAuthTokenKeys = vi.fn(async () => ({}));
const readInstalledExtensionById = vi.fn();
const readInstalledExtensionsByPackageName = vi.fn();
const pickSingleActiveRow = vi.fn();

vi.mock("@cinatra-ai/extensions/lifecycle-primitive", () => ({
  recordExtensionWidgetAuthTokenKeys: (...a: unknown[]) =>
    recordExtensionWidgetAuthTokenKeys(...(a as [])),
}));
vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  readInstalledExtensionById: (...a: unknown[]) => readInstalledExtensionById(...(a as [])),
  readInstalledExtensionsByPackageName: (...a: unknown[]) =>
    readInstalledExtensionsByPackageName(...(a as [])),
}));
vi.mock("@/lib/extension-install-anchor", () => ({
  pickSingleActiveRow: (...a: unknown[]) => pickSingleActiveRow(...(a as [])),
}));

import {
  makeCanonicalRowInstallDeps,
  restorePriorWidgetAuthTokenKeys,
} from "@/lib/extension-install-canonical-row-deps";

const PKG = "@acme/wordpress-runtime-connector";
const KEY = "wordpress_widget_auth";
const passthrough = (u: string) => u;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("widget-auth token-keys canonical write — row binding (owner ruling 2026-07-23)", () => {
  it("DEFAULT install writes to the single active DEFAULT row (the row arm (c) resolves)", async () => {
    const row = { id: "row-default", packageName: PKG, organizationId: null };
    readInstalledExtensionsByPackageName.mockResolvedValue([row]);
    pickSingleActiveRow.mockReturnValue(row);
    const deps = makeCanonicalRowInstallDeps({ provenanceRegistryUrl: passthrough });
    await deps.persistWidgetAuthTokenKeys!({ packageName: PKG, orgId: null, tokenKeys: [KEY] });
    expect(recordExtensionWidgetAuthTokenKeys).toHaveBeenCalledWith(
      "row-default",
      [KEY],
      expect.anything(),
    );
  });

  it("SIDE-BY-SIDE (boundRowId) install writes to ITS OWN bound row — never the default (no clobber of the default declaration)", async () => {
    readInstalledExtensionById.mockResolvedValue({
      id: "row-nondefault",
      packageName: PKG,
      organizationId: null,
    });
    const deps = makeCanonicalRowInstallDeps({
      provenanceRegistryUrl: passthrough,
      boundRowId: "row-nondefault",
    });
    // A non-default sibling that declares no key writes [] to ITS OWN row.
    await deps.persistWidgetAuthTokenKeys!({ packageName: PKG, orgId: null, tokenKeys: [] });
    expect(readInstalledExtensionById).toHaveBeenCalledWith("row-nondefault");
    expect(recordExtensionWidgetAuthTokenKeys).toHaveBeenCalledWith(
      "row-nondefault",
      [],
      expect.anything(),
    );
    // The default-row resolution path is NEVER consulted for a bound row — so a
    // non-default install can never overwrite the default row's declaration.
    expect(pickSingleActiveRow).not.toHaveBeenCalled();
  });

  it("readCurrentWidgetAuthTokenKeys reads the target row's recorded column (null on a legacy row)", async () => {
    const withCol = { id: "r", packageName: PKG, organizationId: null, widgetAuthTokenKeys: [KEY] };
    readInstalledExtensionsByPackageName.mockResolvedValue([withCol]);
    pickSingleActiveRow.mockReturnValue(withCol);
    const deps = makeCanonicalRowInstallDeps({ provenanceRegistryUrl: passthrough });
    expect(await deps.readCurrentWidgetAuthTokenKeys!(PKG, null)).toEqual([KEY]);
    // Legacy row: no column → null.
    pickSingleActiveRow.mockReturnValue({ id: "r", packageName: PKG, organizationId: null });
    expect(await deps.readCurrentWidgetAuthTokenKeys!(PKG, null)).toBeNull();
  });

  it("FAIL-CLOSED: the write throws when no single active row resolves (0 / ambiguous scope)", async () => {
    readInstalledExtensionsByPackageName.mockResolvedValue([]);
    pickSingleActiveRow.mockReturnValue(null);
    const deps = makeCanonicalRowInstallDeps({ provenanceRegistryUrl: passthrough });
    await expect(
      deps.persistWidgetAuthTokenKeys!({ packageName: PKG, orgId: null, tokenKeys: [] }),
    ).rejects.toThrow(/expected exactly 1 active/);
  });
});

describe("restorePriorWidgetAuthTokenKeys — FAIL-CLOSED on a restore-write failure (codex round-4)", () => {
  it("clears the column to [] when the OLD-keys restore write fails (never leaves stale NEW keys against a re-anchored OLD source)", async () => {
    const writes: Array<string[]> = [];
    let call = 0;
    const persist = vi.fn(async (i: { tokenKeys: string[] }) => {
      call += 1;
      if (call === 1) throw new Error("restore write outage"); // the OLD-keys restore
      writes.push(i.tokenKeys); // the fail-closed [] clear
    });
    const failures: string[] = [];
    await restorePriorWidgetAuthTokenKeys(
      { persistWidgetAuthTokenKeys: persist },
      { packageName: PKG, orgId: null, isUpdate: true, prior: [KEY] },
      (r) => failures.push(r),
    );
    // Second write is the fail-closed clear to [].
    expect(writes).toEqual([[]]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/FAIL-CLOSED to \[\]/);
  });

  it("reports a doubly-non-clean rollback when BOTH the restore AND the []-clear fail", async () => {
    const persist = vi.fn(async () => {
      throw new Error("db down");
    });
    const failures: string[] = [];
    await restorePriorWidgetAuthTokenKeys(
      { persistWidgetAuthTokenKeys: persist },
      { packageName: PKG, orgId: null, isUpdate: true, prior: [KEY] },
      (r) => failures.push(r),
    );
    expect(persist).toHaveBeenCalledTimes(2);
    expect(failures[0]).toMatch(/both failed/);
  });

  it("is a no-op on a FRESH install (isUpdate false) and when the persist hook is unwired", async () => {
    const persist = vi.fn(async () => {});
    await restorePriorWidgetAuthTokenKeys(
      { persistWidgetAuthTokenKeys: persist },
      { packageName: PKG, orgId: null, isUpdate: false, prior: [KEY] },
      () => {},
    );
    expect(persist).not.toHaveBeenCalled();
    await restorePriorWidgetAuthTokenKeys({}, { packageName: PKG, orgId: null, isUpdate: true, prior: [KEY] }, () => {});
  });
});
