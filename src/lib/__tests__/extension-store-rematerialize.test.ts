// cinatra#791 — the boot rematerialization sweep (DI-unit, no DB/fs/registry):
// a live, finalized, real-pipeline verdaccio install whose V2 digest dir is
// missing is rebuilt; everything else (present dir, placeholder integrity,
// non-finalized journal, closure package, unknown kind, non-live status) is
// skipped; a per-package materialize failure is non-fatal and reported.
import { describe, it, expect, vi } from "vitest";
import { storeDigestDirV2 } from "@/lib/extension-package-store-core";
import { rematerializeMissingInstalls } from "@/lib/extension-store-rematerialize";

const ROOT = "/data/extensions";
const DIGEST = "d".repeat(128);

function row(over: Partial<{
  packageName: string;
  organizationId: string | null;
  status: string;
  kind: string;
  source: Record<string, unknown> | null;
}> = {}) {
  return {
    packageName: "@cinatra-ai/sweep-fixture",
    organizationId: null,
    status: "active",
    kind: "connector",
    source: {
      type: "verdaccio",
      integrity: "sha512-real",
      registryUrl: "https://registry.cinatra.ai",
      version: "1.0.0",
    },
    ...over,
  };
}

function makeDeps(over: Partial<Parameters<typeof rematerializeMissingInstalls>[0]> = {}) {
  const materialize = vi.fn(async () => ({}));
  return {
    materialize,
    deps: {
      dataRoot: ROOT,
      listRows: async () => [row()],
      readJournalDigest: async () => DIGEST,
      digestDirExists: async () => false,
      materialize,
      ...over,
    },
  };
}

describe("rematerializeMissingInstalls", () => {
  it("rebuilds a live finalized install whose digest dir is missing", async () => {
    const { deps, materialize } = makeDeps();
    const result = await rematerializeMissingInstalls(deps);
    expect(result.rebuilt).toEqual(["@cinatra-ai/sweep-fixture"]);
    expect(result.failed).toEqual([]);
    expect(materialize).toHaveBeenCalledWith({
      packageName: "@cinatra-ai/sweep-fixture",
      version: "1.0.0",
      expectedIntegrity: "sha512-real",
      registryUrl: "https://registry.cinatra.ai",
      expectedKind: "connector",
      storeRoot: ROOT,
    });
  });

  it("no-ops when the digest dir already exists (and checks the V2 path)", async () => {
    const seen: string[] = [];
    const { deps, materialize } = makeDeps({
      digestDirExists: async (dir: string) => {
        seen.push(dir);
        return true;
      },
    });
    const result = await rematerializeMissingInstalls(deps);
    expect(result.rebuilt).toEqual([]);
    expect(materialize).not.toHaveBeenCalled();
    expect(seen).toEqual([
      storeDigestDirV2(ROOT, "connector", "@cinatra-ai/sweep-fixture", DIGEST),
    ]);
  });

  it("skips: non-live status, non-verdaccio source, placeholder integrity, unknown kind, closure packages", async () => {
    const { deps, materialize } = makeDeps({
      listRows: async () => [
        row({ packageName: "@x/archived", status: "archived" }),
        row({ packageName: "@x/local", source: { type: "local", path: "/dev" } }),
        row({
          packageName: "@x/dispatcher",
          source: { type: "verdaccio", integrity: "dispatcher-install", registryUrl: "r", version: "1" },
        }),
        row({ packageName: "@x/weird-kind", kind: "gizmo" }),
        row({
          packageName: "@x/closure",
          source: {
            type: "verdaccio",
            integrity: "sha512-real",
            registryUrl: "r",
            version: "1",
            closureHash: "c".repeat(128),
          },
        }),
      ],
    });
    const result = await rematerializeMissingInstalls(deps);
    expect(result.rebuilt).toEqual([]);
    expect(materialize).not.toHaveBeenCalled();
    // the explicitly-surfaced skips (operator-actionable ones)
    expect(result.skipped).toEqual(["@x/weird-kind", "@x/closure"]);
  });

  it("skips rows without a FINALIZED journal digest (nothing bindable to rebuild)", async () => {
    const { deps, materialize } = makeDeps({ readJournalDigest: async () => null });
    const result = await rematerializeMissingInstalls(deps);
    expect(result.rebuilt).toEqual([]);
    expect(materialize).not.toHaveBeenCalled();
  });

  it("a materialize failure is NON-FATAL and reported per package", async () => {
    const { deps } = makeDeps({
      listRows: async () => [
        row({ packageName: "@x/fails" }),
        row({ packageName: "@x/works" }),
      ],
      materialize: vi.fn(async (input: { packageName: string }) => {
        if (input.packageName === "@x/fails") throw new Error("registry unreachable");
        return {};
      }),
    });
    const result = await rematerializeMissingInstalls(deps);
    expect(result.rebuilt).toEqual(["@x/works"]);
    expect(result.failed).toEqual([
      { packageName: "@x/fails", error: "registry unreachable" },
    ]);
  });

  it("an unreadable canonical store yields an empty sweep (boot must not fail)", async () => {
    const result = await rematerializeMissingInstalls({
      dataRoot: ROOT,
      listRows: async () => {
        throw new Error("no db");
      },
    });
    expect(result).toEqual({ rebuilt: [], skipped: [], failed: [] });
  });

  it("de-dups multiple rows for one (package, org) identity", async () => {
    const { deps, materialize } = makeDeps({
      listRows: async () => [row(), row()],
    });
    const result = await rematerializeMissingInstalls(deps);
    expect(result.rebuilt).toEqual(["@cinatra-ai/sweep-fixture"]);
    expect(materialize).toHaveBeenCalledTimes(1);
  });

  // cinatra#792 — the sweep runs the SHARED journal-gated selector
  // (selectActiveDigest), so it can never rebuild a digest the loader's trust
  // anchor would refuse.
  describe("journal-gated activeDigest selection (cinatra#792)", () => {
    const verdaccioSource = (activeDigest?: string) => ({
      type: "verdaccio",
      integrity: "sha512-real",
      registryUrl: "https://registry.cinatra.ai",
      version: "1.0.0",
      ...(activeDigest ? { activeDigest } : {}),
    });

    it("rebuilds the row's activeDigest when the finalized journal digest confirms it", async () => {
      const { deps, materialize } = makeDeps({
        listRows: async () => [row({ source: verdaccioSource(DIGEST) })],
        readJournalDigest: async () => DIGEST,
      });
      const result = await rematerializeMissingInstalls(deps);
      expect(result.rebuilt).toEqual(["@cinatra-ai/sweep-fixture"]);
      expect(materialize).toHaveBeenCalledTimes(1);
    });

    it("FAILS CLOSED (skip, no rebuild) when the row's activeDigest mismatches the journal digest", async () => {
      const { deps, materialize } = makeDeps({
        listRows: async () => [row({ source: verdaccioSource("e".repeat(128)) })],
        readJournalDigest: async () => DIGEST,
      });
      const result = await rematerializeMissingInstalls(deps);
      expect(result.rebuilt).toEqual([]);
      expect(result.skipped).toEqual(["@cinatra-ai/sweep-fixture"]);
      expect(materialize).not.toHaveBeenCalled();
    });

    it("FAILS CLOSED when the row carries an activeDigest but no finalized journal digest exists", async () => {
      const { deps, materialize } = makeDeps({
        listRows: async () => [row({ source: verdaccioSource(DIGEST) })],
        readJournalDigest: async () => null,
      });
      const result = await rematerializeMissingInstalls(deps);
      expect(result.rebuilt).toEqual([]);
      expect(result.skipped).toEqual(["@cinatra-ai/sweep-fixture"]);
      expect(materialize).not.toHaveBeenCalled();
    });

    it("a row WITHOUT activeDigest keeps the journal-digest fallback (legacy rows)", async () => {
      const { deps, materialize } = makeDeps({
        listRows: async () => [row({ source: verdaccioSource() })],
        readJournalDigest: async () => DIGEST,
      });
      const result = await rematerializeMissingInstalls(deps);
      expect(result.rebuilt).toEqual(["@cinatra-ai/sweep-fixture"]);
      expect(materialize).toHaveBeenCalledTimes(1);
    });
  });
});
