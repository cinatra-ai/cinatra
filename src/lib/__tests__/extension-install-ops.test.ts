import { describe, it, expect } from "vitest";
import {
  beginInstallOp,
  advanceInstallOpPhase,
  finalizeInstallOp,
  failInstallOp,
  readInstallOp,
  readLatestInstallOpPhase,
  listUnfinalizedInstallOps,
  type InstallOpsDeps,
} from "@/lib/extension-install-ops";

// A tiny in-memory journal that emulates the SQL the store issues. It keys rows
// by (package_name, org_id) for SELECT/UPDATE-by-package and by install_op_id
// for UPDATE-by-id, mirroring the store's two access patterns — enough to assert
// phase advancement + idempotency without a Postgres.
// cinatra#158: an APPEND-ONLY in-memory journal — one row per install_op_id —
// that emulates the SQL the store now issues: INSERT … ON CONFLICT (install_op_id)
// DO UPDATE (begin), UPDATE … WHERE install_op_id (advance), the finalize
// supersession transaction (SELECT self, UPDATE demote-prior-finalized, UPDATE
// promote-self), the anchor/latest reads, and the unfinalized sweep. The unique
// partial-finalized index is enforced manually so a buggy double-finalize throws.
function makeFakeDeps(): { deps: InstallOpsDeps; rows: () => Array<Record<string, unknown>> } {
  const store: Array<Record<string, unknown>> = [];
  let seq = 0;
  const orgMatch = (row: Record<string, unknown>, pkg: string, sqlOrgNull: boolean, orgVal: unknown) =>
    row.package_name === pkg && (sqlOrgNull ? row.org_id === null : row.org_id === orgVal);

  const query: InstallOpsDeps["query"] = async <T,>(text: string, values?: readonly unknown[]) => {
    const v = values ?? [];
    const sqlOrgNull = /org_id IS NULL/.test(text);
    if (/^INSERT/.test(text)) {
      // begin: INSERT ... ON CONFLICT (install_op_id) DO UPDATE ... WHERE phase NOT IN (terminal).
      const [install_op_id, package_name, org_id, phase, digest] = v as unknown[];
      const existing = store.find((r) => r.install_op_id === install_op_id);
      if (existing) {
        // TERMINAL-PRESERVING: the conflict WHERE skips a terminal row (no RETURNING
        // row → the caller re-reads by id). Mirror that here.
        const TERMINAL = ["finalized", "superseded", "failed", "rolled_back"];
        if (TERMINAL.includes(existing.phase as string)) return [] as T[];
        Object.assign(existing, { phase, digest: digest ?? null, updated_at: `t${seq++}` });
        return [existing] as T[];
      }
      const row = { install_op_id, package_name, org_id, phase, digest: digest ?? null, started_at: `t${seq}`, updated_at: `t${seq++}` };
      store.push(row);
      return [row] as T[];
    }
    if (/^\s*SELECT/.test(text) && /WHERE install_op_id = \$1 LIMIT 1/.test(text)) {
      // finalize self-read: SELECT ... WHERE install_op_id = $1.
      const row = store.find((r) => r.install_op_id === v[0]);
      return (row ? [row] : []) as T[];
    }
    if (/^\s*SELECT/.test(text) && /phase <> ALL\(\$1/.test(text)) {
      // listUnfinalizedInstallOps: WHERE phase <> ALL($1) AND updated_at < ... ORDER BY updated_at ASC.
      const terminal = v[0] as string[];
      return store
        .filter((r) => !terminal.includes(r.phase as string))
        .sort((a, b) => String(a.updated_at).localeCompare(String(b.updated_at))) as T[];
    }
    if (/^\s*SELECT/.test(text)) {
      // anchor / latest read: WHERE package_name=$1 AND <org> ORDER BY (phase='finalized') DESC ... LIMIT 1.
      const pkg = v[0] as string;
      const matching = store.filter((r) => orgMatch(r, pkg, sqlOrgNull, v[1]));
      if (matching.length === 0) return [] as T[];
      const fin = matching.find((r) => r.phase === "finalized");
      const latest = [...matching].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0];
      return [fin ?? latest] as T[];
    }
    if (/^\s*UPDATE/.test(text) && /SET phase = 'superseded'/.test(text)) {
      // finalize demote: demote the prior finalized op for self's scope (install_op_id <> $1).
      const selfId = v[0];
      const self = store.find((r) => r.install_op_id === selfId);
      if (!self) return [] as T[];
      for (const r of store) {
        if (r.install_op_id !== selfId && orgMatch(r, self.package_name as string, self.org_id === null, self.org_id) && r.phase === "finalized") {
          r.phase = "superseded";
        }
      }
      return [] as T[];
    }
    if (/^\s*UPDATE/.test(text) && /SET phase = 'finalized'/.test(text)) {
      // finalize promote: SET phase='finalized' WHERE install_op_id = $1.
      const row = store.find((r) => r.install_op_id === v[0]);
      if (!row) return [] as T[];
      // Enforce the partial-unique-on-finalized invariant (one finalized per scope).
      const dupe = store.find(
        (r) => r !== row && r.phase === "finalized" && orgMatch(r, row.package_name as string, row.org_id === null, row.org_id),
      );
      if (dupe) { const e = new Error("duplicate finalized") as Error & { code?: string }; e.code = "23505"; throw e; }
      row.phase = "finalized";
      row.updated_at = `t${seq++}`;
      return [row] as T[];
    }
    if (/^\s*UPDATE/.test(text)) {
      // advance path: SET phase = $1 [, digest = $2] WHERE install_op_id = $N.
      const phase = v[0];
      const hasDigest = /digest = \$2/.test(text);
      const opId = hasDigest ? v[2] : v[1];
      const row = store.find((r) => r.install_op_id === opId);
      if (!row) return [] as T[];
      // The partial-unique-on-finalized index rejects a second finalized for a scope
      // (a raw advance to finalized that bypasses the supersession seam trips it).
      if (phase === "finalized") {
        const dupe = store.find(
          (r) => r !== row && r.phase === "finalized" && orgMatch(r, row.package_name as string, row.org_id === null, row.org_id),
        );
        if (dupe) { const e = new Error("duplicate finalized") as Error & { code?: string }; e.code = "23505"; throw e; }
      }
      row.phase = phase;
      if (hasDigest) row.digest = v[1] ?? null;
      row.updated_at = `t${seq++}`;
      return [row] as T[];
    }
    return [] as T[];
  };

  return { deps: { query }, rows: () => store };
}

describe("extension-install-ops journal store", () => {
  it("beginInstallOp inserts a row at the 'materialized' phase by default", async () => {
    const { deps } = makeFakeDeps();
    const op = await beginInstallOp({ installOpId: "op1", packageName: "@cinatra-ai/foo", orgId: null }, deps);
    expect(op.phase).toBe("materialized");
    expect(op.installOpId).toBe("op1");
    expect(await readInstallOp("@cinatra-ai/foo", null, deps)).toMatchObject({ phase:"materialized" });
  });

  it("advanceInstallOpPhase moves the row through granted → finalized", async () => {
    const { deps } = makeFakeDeps();
    await beginInstallOp({ installOpId: "op1", packageName: "@cinatra-ai/foo", orgId: null }, deps);
    await advanceInstallOpPhase({ installOpId: "op1", phase: "granted" }, deps);
    expect(await readInstallOp("@cinatra-ai/foo", null, deps)).toMatchObject({ phase:"granted" });
    await finalizeInstallOp("op1", deps);
    expect(await readInstallOp("@cinatra-ai/foo", null, deps)).toMatchObject({ phase:"finalized" });
  });

  it("failInstallOp marks the row 'failed'", async () => {
    const { deps } = makeFakeDeps();
    await beginInstallOp({ installOpId: "op1", packageName: "@cinatra-ai/foo", orgId: null }, deps);
    await failInstallOp("op1", deps);
    expect(await readInstallOp("@cinatra-ai/foo", null, deps)).toMatchObject({ phase:"failed" });
  });

  it("cinatra#158: APPEND-ONLY — a NEW attempt APPENDS a row and never destroys the prior finalized op; the anchor stays the finalized op", async () => {
    const { deps, rows } = makeFakeDeps();
    await beginInstallOp({ installOpId: "op1", packageName: "@cinatra-ai/foo", orgId: null }, deps);
    await finalizeInstallOp("op1", deps);
    // a fresh attempt for the same package APPENDS a second row (does NOT reset op1)
    const op2 = await beginInstallOp({ installOpId: "op2", packageName: "@cinatra-ai/foo", orgId: null }, deps);
    expect(rows().length).toBe(2);
    expect(op2.installOpId).toBe("op2");
    expect(op2.phase).toBe("materialized");
    // op1 is UNTOUCHED — still finalized — and is the anchor (readInstallOp prefers finalized).
    expect(rows().find((r) => r.install_op_id === "op1")).toMatchObject({ phase: "finalized" });
    expect(await readInstallOp("@cinatra-ai/foo", null, deps)).toMatchObject({ phase: "finalized", installOpId: "op1" });
  });

  it("cinatra#158: a re-begin of the SAME op id resets THAT row (idempotent resume); a finalize supersedes the prior finalized op", async () => {
    const { deps, rows } = makeFakeDeps();
    await beginInstallOp({ installOpId: "op1", packageName: "@cinatra-ai/foo", orgId: null }, deps);
    await finalizeInstallOp("op1", deps);
    // op2 is a SUCCESSFUL update: finalize demotes op1 → superseded, promotes op2.
    await beginInstallOp({ installOpId: "op2", packageName: "@cinatra-ai/foo", orgId: null }, deps);
    await finalizeInstallOp("op2", deps);
    expect(rows().find((r) => r.install_op_id === "op1")).toMatchObject({ phase: "superseded" });
    expect(rows().find((r) => r.install_op_id === "op2")).toMatchObject({ phase: "finalized" });
    expect(await readInstallOp("@cinatra-ai/foo", null, deps)).toMatchObject({ phase: "finalized", installOpId: "op2" });
    // TERMINAL-PRESERVING (codex diff finding): a re-begin of op2 (now finalized)
    // PRESERVES it — it never downgrades the live anchor back to materialized — and
    // never inserts a 3rd row.
    const reBegun = await beginInstallOp({ installOpId: "op2", packageName: "@cinatra-ai/foo", orgId: null }, deps);
    expect(reBegun.phase).toBe("finalized");
    expect(rows().filter((r) => r.install_op_id === "op2")).toHaveLength(1);
  });

  it("cinatra#158: a re-begin of an IN-FLIGHT (non-terminal) op id resets THAT row (idempotent resume)", async () => {
    const { deps, rows } = makeFakeDeps();
    await beginInstallOp({ installOpId: "op1", packageName: "@cinatra-ai/foo", orgId: null }, deps);
    await advanceInstallOpPhase({ installOpId: "op1", phase: "granted" }, deps);
    // re-begin a non-terminal op resets it to materialized (a resumed attempt).
    const reBegun = await beginInstallOp({ installOpId: "op1", packageName: "@cinatra-ai/foo", orgId: null }, deps);
    expect(reBegun.phase).toBe("materialized");
    expect(rows().filter((r) => r.install_op_id === "op1")).toHaveLength(1);
  });

  it("keeps org-scoped and global journal rows separate", async () => {
    const { deps, rows } = makeFakeDeps();
    await beginInstallOp({ installOpId: "g", packageName: "@cinatra-ai/foo", orgId: null }, deps);
    await beginInstallOp({ installOpId: "o", packageName: "@cinatra-ai/foo", orgId: "org1" }, deps);
    expect(rows().length).toBe(2);
    await advanceInstallOpPhase({ installOpId: "o", phase: "finalized" }, deps);
    expect(await readInstallOp("@cinatra-ai/foo", null, deps)).toMatchObject({ phase:"materialized" });
    expect(await readInstallOp("@cinatra-ai/foo", "org1", deps)).toMatchObject({ phase:"finalized" });
  });

  it("readInstallOp returns null when no journal row exists", async () => {
    const { deps } = makeFakeDeps();
    expect(await readInstallOp("@cinatra-ai/missing", null, deps)).toBeNull();
  });

  it("cinatra#158: finalize is the SUPERSESSION seam — a concurrent double-finalize is refused by the partial-unique invariant (23505)", async () => {
    const { deps } = makeFakeDeps();
    await beginInstallOp({ installOpId: "op1", packageName: "@cinatra-ai/foo", orgId: null }, deps);
    await finalizeInstallOp("op1", deps);
    // op2 finalize demotes op1 then promotes op2 — only ONE finalized at a time.
    await beginInstallOp({ installOpId: "op2", packageName: "@cinatra-ai/foo", orgId: null }, deps);
    await finalizeInstallOp("op2", deps);
    // Direct double-promote without demote would trip the unique index (the
    // supersession seam prevents it; a raw advance does not run the demote).
    await beginInstallOp({ installOpId: "op3", packageName: "@cinatra-ai/foo", orgId: null }, deps);
    await expect(advanceInstallOpPhase({ installOpId: "op3", phase: "finalized" }, deps)).rejects.toThrow(/duplicate finalized/);
  });

  describe("readLatestInstallOpPhase (the non-finalized-window reader, cinatra#158)", () => {
    it("returns 'finalized' (healthy) whenever a finalized op exists — even with a newer terminalized attempt", async () => {
      const { deps } = makeFakeDeps();
      await beginInstallOp({ installOpId: "op1", packageName: "@cinatra-ai/foo", orgId: null }, deps);
      await finalizeInstallOp("op1", deps);
      // a newer FAILED attempt is terminalized — must NOT make the row look broken.
      await beginInstallOp({ installOpId: "op2", packageName: "@cinatra-ai/foo", orgId: null }, deps);
      await failInstallOp("op2", deps);
      await advanceInstallOpPhase({ installOpId: "op2", phase: "rolled_back" }, deps);
      expect(await readLatestInstallOpPhase("@cinatra-ai/foo", null, deps)).toBe("finalized");
    });

    it("returns the in-flight phase when NO finalized op exists (non-finalized window → rollbackable)", async () => {
      const { deps } = makeFakeDeps();
      await beginInstallOp({ installOpId: "op1", packageName: "@cinatra-ai/foo", orgId: null }, deps);
      await advanceInstallOpPhase({ installOpId: "op1", phase: "granted" }, deps);
      expect(await readLatestInstallOpPhase("@cinatra-ai/foo", null, deps)).toBe("granted");
    });

    it("returns the latest TERMINAL phase when the install only ever rolled back (still non-anchorable)", async () => {
      const { deps } = makeFakeDeps();
      await beginInstallOp({ installOpId: "op1", packageName: "@cinatra-ai/foo", orgId: null }, deps);
      await failInstallOp("op1", deps);
      await advanceInstallOpPhase({ installOpId: "op1", phase: "rolled_back" }, deps);
      expect(await readLatestInstallOpPhase("@cinatra-ai/foo", null, deps)).toBe("rolled_back");
    });

    it("returns null when no journal row exists at all", async () => {
      const { deps } = makeFakeDeps();
      expect(await readLatestInstallOpPhase("@cinatra-ai/missing", null, deps)).toBeNull();
    });
  });

  describe("listUnfinalizedInstallOps (boot-orphan sweep, cinatra#158)", () => {
    it("returns EVERY non-terminal op and EXCLUDES finalized/superseded/failed/rolled_back (terminal)", async () => {
      const { deps } = makeFakeDeps();
      // a finalized anchor + a superseded prior + a stuck non-terminal attempt.
      await beginInstallOp({ installOpId: "old", packageName: "@cinatra-ai/foo", orgId: null }, deps);
      await finalizeInstallOp("old", deps);
      await beginInstallOp({ installOpId: "new", packageName: "@cinatra-ai/foo", orgId: null }, deps);
      await finalizeInstallOp("new", deps); // demotes "old" → superseded
      await beginInstallOp({ installOpId: "stuck", packageName: "@cinatra-ai/foo", orgId: null }, deps);
      await advanceInstallOpPhase({ installOpId: "stuck", phase: "preflighted" }, deps);
      const unfinalized = await listUnfinalizedInstallOps(0, deps);
      const ids = unfinalized.map((o) => o.installOpId).sort();
      // Only the stuck non-terminal op is swept; finalized + superseded are never swept.
      expect(ids).toEqual(["stuck"]);
    });
  });
});
