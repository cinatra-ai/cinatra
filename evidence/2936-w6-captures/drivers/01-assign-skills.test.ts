// THE ONE ALLOWED LANE WRITE, DISCLOSED: four organization-owned skill
// assignments through the SHIPPED writer `upsertCustomSkillAssignment`, so the
// run's recommendation hold has four candidates to draw a chip for. Nothing
// else is written: no run, no gate, no park, no record, no review task, no
// status. The resolved set is read back through the shipped reader.
import { expect, test } from "vitest";

const ORG = process.env.WALK_ORG_ID!;
const USER = process.env.WALK_USER_ID!;
const AGENT = process.env.WALK_AGENT_PKG!;
const SKILLS = (process.env.WALK_SKILL_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

test("four skills are assigned through the shipped writer", async () => {
  expect(ORG && USER && AGENT).toBeTruthy();
  expect(SKILLS.length).toBe(4);
  const { upsertCustomSkillAssignment } = await import("@/lib/database");
  for (const skillId of SKILLS) {
    upsertCustomSkillAssignment({
      skillId,
      agentId: AGENT,
      ownerType: "organization" as never,
      ownerId: ORG,
      createdBy: USER,
    });
  }
  const { getAssignedSkillIdsForAgent } = await import("@/lib/agents-store");
  const resolved = await getAssignedSkillIdsForAgent(AGENT, {
    principalId: USER,
    teamIds: [],
    projectIds: [],
    organizationId: ORG,
  } as never);
  console.log("ASSIGN " + JSON.stringify({ agentId: AGENT, wrote: SKILLS, resolved }, null, 1));
  for (const s of SKILLS) expect(resolved).toContain(s);
});
