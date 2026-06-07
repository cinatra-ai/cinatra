import { describe, it, expect } from "vitest";
import {
  beginInstallOp,
  advanceInstallOpPhase,
  finalizeInstallOp,
  failInstallOp,
  readInstallOp,
  type InstallOpsDeps,
} from "@/lib/extension-install-ops";

// A tiny in-memory journal that emulates the SQL the store issues. It keys rows
// by (package_name, org_id) for SELECT/UPDATE-by-package and by install_op_id
// for UPDATE-by-id, mirroring the store's two access patterns — enough to assert
// phase advancement + idempotency without a Postgres.
function makeFakeDeps(): { deps: InstallOpsDeps; rows: () => Array<Record<string, unknown>> } {
  const store: Array<Record<string, unknown>> = [];
  const orgMatch = (row: Record<string, unknown>, pkg: string, sqlOrgNull: boolean, orgVal: unknown) =>
    row.package_name === pkg && (sqlOrgNull ? row.org_id === null : row.org_id === orgVal);

  const query: InstallOpsDeps["query"] = async <T,>(text: string, values?: readonly unknown[]) => {
    const v = values ?? [];
    const sqlOrgNull = /org_id IS NULL/.test(text);
    if (text.startsWith("SELECT")) {
      const pkg = v[0] as string;
      const row = store.find((r) => orgMatch(r, pkg, sqlOrgNull, v[1]));
      return (row ? [row] : []) as T[];
    }
    if (/^INSERT/.test(text)) {
      const [install_op_id, package_name, org_id, phase, digest] = v as unknown[];
      const row = {
        install_op_id,
        package_name,
        org_id,
        phase,
        digest: digest ?? null,
        started_at: "t0",
        updated_at: "t0",
      };
      store.push(row);
      return [row] as T[];
    }
    if (/^\s*UPDATE/.test(text) && /SET install_op_id/.test(text)) {
      // begin-reset path: UPDATE ... WHERE package_name = $4 AND <orgclause>
      const [install_op_id, phase, digest, pkg] = v as unknown[];
      const row = store.find((r) => orgMatch(r, pkg as string, sqlOrgNull, v[4]));
      if (!row) return [] as T[];
      Object.assign(row, { install_op_id, phase, digest: digest ?? null, updated_at: "t1" });
      return [row] as T[];
    }
    if (/^\s*UPDATE/.test(text)) {
      // advance path: SET phase = $1 [, digest = $2] WHERE install_op_id = $N
      const phase = v[0];
      const hasDigest = /digest = \$2/.test(text);
      const opId = hasDigest ? v[2] : v[1];
      const row = store.find((r) => r.install_op_id === opId);
      if (!row) return [] as T[];
      row.phase = phase;
      if (hasDigest) row.digest = v[1] ?? null;
      row.updated_at = "t1";
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

  it("is idempotent on (package, org) — a second begin RESETS the row, never inserts a duplicate", async () => {
    const { deps, rows } = makeFakeDeps();
    await beginInstallOp({ installOpId: "op1", packageName: "@cinatra-ai/foo", orgId: null }, deps);
    await advanceInstallOpPhase({ installOpId: "op1", phase: "finalized" }, deps);
    // a fresh attempt for the same package supersedes the finalized row
    const op2 = await beginInstallOp({ installOpId: "op2", packageName: "@cinatra-ai/foo", orgId: null }, deps);
    expect(rows().length).toBe(1);
    expect(op2.installOpId).toBe("op2");
    expect(op2.phase).toBe("materialized");
    expect(await readInstallOp("@cinatra-ai/foo", null, deps)).toMatchObject({ phase:"materialized" });
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
});
