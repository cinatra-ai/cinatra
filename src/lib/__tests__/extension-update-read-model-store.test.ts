// DB-backed ExtensionUpdateReadModelStore adapter (cinatra#1041 outcome 3) —
// SQL shapes + row mapping over the injected query (no DB), mirroring
// extension-install-batch-ops.test's injected-query pattern. The port
// semantics (missing → stale, staleness at read) are covered in the registries
// package's update-read-model.test; here we pin the adapter's persistence.
import { describe, expect, it, vi } from "vitest";

import {
  DbExtensionUpdateReadModelStore,
  readInstalledUpdateReadouts,
  UPDATE_READ_MODEL_TTL_MS,
} from "@/lib/extension-update-read-model-store";
import type { ExtensionUpdateEntry } from "@cinatra-ai/registries/src/update-read-model";

function store(query: ReturnType<typeof vi.fn>) {
  return new DbExtensionUpdateReadModelStore({ query: query as never, schema: "cinatra" });
}

describe("DbExtensionUpdateReadModelStore.read", () => {
  it("selects only the requested names and maps rows (timestamptz Date → ISO)", async () => {
    const refreshed = new Date("2026-07-10T12:00:00.000Z");
    const query = vi.fn().mockResolvedValue([
      {
        package_name: "@cinatra-ai/a",
        latest_version: "1.2.0",
        latest_sdk_abi_range: ">=1.0.0",
        refreshed_at: refreshed, // pg returns a Date for timestamptz
      },
      {
        package_name: "@cinatra-ai/b",
        latest_version: null,
        latest_sdk_abi_range: null,
        refreshed_at: "2026-07-10T11:00:00.000Z", // string tolerated too
      },
    ]);
    const map = await store(query).read(["@cinatra-ai/a", "@cinatra-ai/b"]);

    const [text, values] = query.mock.calls[0];
    expect(text).toContain('"cinatra"."extension_update_read_model"');
    expect(text).toContain("package_name = ANY($1::text[])");
    expect(values).toEqual([["@cinatra-ai/a", "@cinatra-ai/b"]]);

    expect(map.get("@cinatra-ai/a")).toEqual({
      packageName: "@cinatra-ai/a",
      latestVersion: "1.2.0",
      latestSdkAbiRange: ">=1.0.0",
      refreshedAt: "2026-07-10T12:00:00.000Z",
    });
    expect(map.get("@cinatra-ai/b")?.latestVersion).toBeNull();
    expect(map.get("@cinatra-ai/b")?.latestSdkAbiRange).toBeNull();
  });

  it("short-circuits an empty name list without touching the DB", async () => {
    const query = vi.fn();
    const map = await store(query).read([]);
    expect(map.size).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });
});

describe("DbExtensionUpdateReadModelStore.upsert", () => {
  it("insert-or-replaces via unnest arrays keyed on package_name", async () => {
    const query = vi.fn().mockResolvedValue([]);
    const entries: ExtensionUpdateEntry[] = [
      {
        packageName: "@cinatra-ai/a",
        latestVersion: "1.2.0",
        latestSdkAbiRange: ">=1.0.0",
        refreshedAt: "2026-07-10T12:00:00.000Z",
      },
      {
        packageName: "@cinatra-ai/b",
        latestVersion: null,
        latestSdkAbiRange: null,
        refreshedAt: "2026-07-10T12:00:00.000Z",
      },
    ];
    await store(query).upsert(entries);

    const [text, values] = query.mock.calls[0];
    expect(text).toContain("INSERT INTO");
    expect(text).toContain("unnest($1::text[], $2::text[], $3::text[], $4::timestamptz[])");
    expect(text).toContain("ON CONFLICT (package_name) DO UPDATE");
    // Parallel arrays preserve null latest fields as SQL NULLs.
    expect(values).toEqual([
      ["@cinatra-ai/a", "@cinatra-ai/b"],
      ["1.2.0", null],
      [">=1.0.0", null],
      ["2026-07-10T12:00:00.000Z", "2026-07-10T12:00:00.000Z"],
    ]);
  });

  it("no-ops an empty entry list", async () => {
    const query = vi.fn();
    await store(query).upsert([]);
    expect(query).not.toHaveBeenCalled();
  });
});

describe("readInstalledUpdateReadouts", () => {
  it("resolves readouts via the injected store with the standard TTL (missing → stale)", async () => {
    const query = vi.fn().mockResolvedValue([
      {
        package_name: "@cinatra-ai/fresh",
        latest_version: "2.0.0",
        latest_sdk_abi_range: null,
        refreshed_at: new Date("2026-07-10T11:30:00.000Z"),
      },
    ]);
    const injected = store(query);
    const now = new Date("2026-07-10T12:00:00.000Z");
    const readouts = await readInstalledUpdateReadouts(
      ["@cinatra-ai/fresh", "@cinatra-ai/never-synced"],
      { store: injected, now },
    );

    expect(readouts.map((r) => r.packageName)).toEqual([
      "@cinatra-ai/fresh",
      "@cinatra-ai/never-synced",
    ]);
    // 30 min old under the 24h TTL → fresh.
    expect(readouts[0].stale).toBe(false);
    expect(readouts[0].entry?.latestVersion).toBe("2.0.0");
    // Never synced → absent entry → stale (fail-quiet at the render site).
    expect(readouts[1].entry).toBeNull();
    expect(readouts[1].stale).toBe(true);
  });

  it("exposes a lenient (multi-hour) default TTL", () => {
    expect(UPDATE_READ_MODEL_TTL_MS).toBeGreaterThanOrEqual(60 * 60 * 1000);
  });
});
