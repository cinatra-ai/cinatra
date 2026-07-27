// LIVE real-Postgres proof of the per-agent execution-config storage
// (exec-plane S3 slice B, cinatra#1708) — the surface→store→surface round trip.
//
// The declared environment persists as JSON-as-text on a column added by
// core__0085, so a naive column-type assumption or a missed deserializer wiring
// would silently drop the declaration and every run would fall back to the base
// image without saying so. This suite exercises the REAL store functions against
// a real Postgres schema:
//
//   1. a declared environment written by the config surface reads back as the
//      exact canonical spec, and the three-valued posture survives;
//   2. clearing the declaration stores NULL (never "{}") so an env-less template
//      keeps its legacy snapshot shape;
//   3. the immutable version snapshot CAPTURES the stored declaration — the
//      pinned-run guarantee that a later config edit cannot swap the
//      environment under a pinned run;
//   4. unparseable stored text resolves as an INVALID declaration, never as
//      "no environment".
//
// Skips when no DB is configured (same pattern as the sibling integration
// suites in this directory).
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";

const dbUrl = process.env.SUPABASE_DB_URL;
const hasDb =
  typeof dbUrl === "string" &&
  dbUrl.length > 0 &&
  !dbUrl.includes("unused:unused@localhost:5432/unused");

const baseSeed = (id: string, packageName: string) => ({
  id,
  name: "exec-config-rt",
  sourceNl: "x",
  compiledPlan: [],
  inputSchema: {},
  approvalPolicy: { steps: [] },
  packageName,
  packageVersion: "1.0.0",
});

describe.skipIf(!hasDb)("cinatra#1708 slice B — per-agent execution config, real Postgres", () => {
  it("persists a declared environment + posture and reads back the canonical spec", async () => {
    const { createAgentTemplate, readAgentTemplateById, readAgentTemplateByPackageName } =
      await import("../store");
    const { writeAgentExecutionConfig } = await import("../execution-config-store");
    const { parseAgentExecutionConfigSubmission } = await import("../execution-config");

    const id = `t_${randomUUID()}`;
    const packageName = `@cinatra-ai/exec-${randomUUID().slice(0, 8)}`;
    await createAgentTemplate(baseSeed(id, packageName));

    const before = await readAgentTemplateById(id);
    expect(before!.executionEnvironment ?? null).toBeNull();
    expect(before!.executionEnabled ?? null).toBeNull();

    // Exactly what the surface submits (unsorted, duplicated — the parser
    // canonicalizes; the canonical form is what the builder hashes).
    const parsed = parseAgentExecutionConfigSubmission({
      executionEnabled: "on",
      pip: "pandas\nnumpy\npandas",
      os: "pandoc",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(await writeAgentExecutionConfig(id, parsed.config)).toBe(true);

    const after = await readAgentTemplateById(id);
    expect(after!.executionEnvironment).toEqual({ os: ["pandoc"], pip: ["numpy", "pandas"] });
    expect(after!.executionEnabled).toBe(true);

    // The settings surface reads by PACKAGE NAME — same row, same declaration.
    const byPackage = await readAgentTemplateByPackageName(packageName);
    expect(byPackage!.executionEnvironment).toEqual({ os: ["pandoc"], pip: ["numpy", "pandas"] });
  });

  it("clearing the declaration stores NULL (not '{}') and the posture returns to inherit", async () => {
    const { createAgentTemplate, readAgentTemplateById } = await import("../store");
    const { writeAgentExecutionConfig } = await import("../execution-config-store");

    const id = `t_${randomUUID()}`;
    await createAgentTemplate(baseSeed(id, `@cinatra-ai/exec-${randomUUID().slice(0, 8)}`));
    await writeAgentExecutionConfig(id, {
      executionEnabled: true,
      environment: { npm: ["prettier"] },
    });
    expect((await readAgentTemplateById(id))!.executionEnvironment).toEqual({ npm: ["prettier"] });

    await writeAgentExecutionConfig(id, { executionEnabled: null, environment: {} });
    const cleared = await readAgentTemplateById(id);
    // null — NOT `{}`: "declares nothing" and "has no declaration" are one state.
    expect(cleared!.executionEnvironment).toBeNull();
    expect(cleared!.executionEnabled).toBeNull();
  });

  it("the immutable version snapshot CAPTURES the stored declaration (the pinned-run guarantee)", async () => {
    const { createAgentTemplate, readAgentTemplateById } = await import("../store");
    const { writeAgentExecutionConfig } = await import("../execution-config-store");
    const { buildSnapshotFromTemplate } = await import("../template-snapshot");
    const { resolveRunExecutionEnvironment } = await import("../execution-environment");

    const id = `t_${randomUUID()}`;
    await createAgentTemplate(baseSeed(id, `@cinatra-ai/exec-${randomUUID().slice(0, 8)}`));
    await writeAgentExecutionConfig(id, {
      executionEnabled: null,
      environment: { pip: ["pandas"] },
    });
    const pinnedSnapshot = buildSnapshotFromTemplate((await readAgentTemplateById(id))!);
    expect(pinnedSnapshot.executionEnvironment).toEqual({ pip: ["pandas"] });

    // The live config then changes…
    await writeAgentExecutionConfig(id, {
      executionEnabled: null,
      environment: { pip: ["polars"] },
    });
    const live = await readAgentTemplateById(id);

    // …and a PINNED run still resolves the snapshot's recipe, not the live row.
    expect(
      resolveRunExecutionEnvironment({
        pinnedSnapshot,
        liveTemplateEnvironment: live!.executionEnvironment,
      }),
    ).toEqual({ kind: "declared", spec: { pip: ["pandas"] }, source: "version-snapshot" });
  });

  it("unparseable stored text resolves INVALID — never silently 'no environment'", async () => {
    const { createAgentTemplate, readAgentTemplateById } = await import("../store");
    const { db } = await import("../db");
    const { agentTemplates } = await import("../schema");
    const { eq } = await import("drizzle-orm");
    const { resolveRunExecutionEnvironment } = await import("../execution-environment");

    const id = `t_${randomUUID()}`;
    await createAgentTemplate(baseSeed(id, `@cinatra-ai/exec-${randomUUID().slice(0, 8)}`));
    // Corrupt the column the way a direct SQL write could.
    await db
      .update(agentTemplates)
      .set({ executionEnvironment: "not json at all" })
      .where(eq(agentTemplates.id, id));

    const row = await readAgentTemplateById(id);
    const resolved = resolveRunExecutionEnvironment({
      liveTemplateEnvironment: row!.executionEnvironment,
    });
    expect(resolved.kind).toBe("invalid");
  });
});
