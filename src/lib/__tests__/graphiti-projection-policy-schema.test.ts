// Bootstrap DDL contract for the projection-policy epoch + durable rebuild
// journal (cinatra#1427 ACs 4-5). Pure string assertions — no DB. Guards the
// invariant the code comments assert: the rebuild-journal phase CHECK and the
// REBUILD_JOURNAL_PHASES vocabulary stay in sync.

import { describe, it, expect } from "vitest";
import { graphitiProjectionPolicySchemaQueries } from "@/lib/graphiti-projection-policy-schema";
import { REBUILD_JOURNAL_PHASES } from "@cinatra-ai/objects/graphiti-projection-policy";

const ddl = graphitiProjectionPolicySchemaQueries("cinatra")
  .map((q) => q.text)
  .join("\n");

describe("graphiti projection-policy schema DDL", () => {
  it("creates the per-group epoch table with a monotonic (>=1) epoch check", () => {
    expect(ddl).toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+"cinatra"\."graphiti_projection_policy"/i);
    expect(ddl).toMatch(/group_id\s+text\s+PRIMARY\s+KEY/i);
    expect(ddl).toMatch(/CHECK\s*\(epoch\s*>=\s*1\)/i);
  });

  it("creates the durable rebuild journal with a to_epoch > from_epoch check", () => {
    expect(ddl).toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+"cinatra"\."graphiti_rebuild_journal"/i);
    expect(ddl).toMatch(/checkpoint\s+jsonb/i);
    expect(ddl).toMatch(/CHECK\s*\(to_epoch\s*>\s*from_epoch\)/i);
  });

  it("enforces at most ONE open rebuild journal per group (partial unique index)", () => {
    expect(ddl).toMatch(
      /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+graphiti_rebuild_journal_one_open[\s\S]*\(group_id\)\s+WHERE\s+phase\s*<>\s*'done'/i,
    );
  });

  it("the phase CHECK lists EXACTLY the REBUILD_JOURNAL_PHASES vocabulary", () => {
    const m = ddl.match(/phase\s+IN\s*\(([^)]*)\)/i);
    expect(m).not.toBeNull();
    const phases = m![1].split(",").map((s) => s.trim().replace(/^'|'$/g, ""));
    expect(phases).toEqual([...REBUILD_JOURNAL_PHASES]);
  });
});
