import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

const SOURCE = readFileSync("src/app/projects/new/page.tsx", "utf-8");

describe("/projects/new server component + createProjectAction", () => {
  it("imports redirect from next/navigation", () => {
    expect(SOURCE).toMatch(/from\s+"next\/navigation"/);
    expect(SOURCE).toMatch(/redirect/);
  });

  it("imports requireAuthSession from auth-session", () => {
    expect(SOURCE).toMatch(/from\s+"@\/lib\/auth-session"/);
    expect(SOURCE).toMatch(/requireAuthSession/);
  });

  it("uses Better Auth SQL to fetch teams + orgs for the page dropdowns", () => {
    expect(SOURCE).toMatch(/from\s+"@\/lib\/better-auth-db"/);
    // Page-level dropdown queries
    expect(SOURCE).toMatch(/public\.team\b/);
    expect(SOURCE).toMatch(/public\.organization\b/);
    expect(SOURCE).toMatch(/public\."teamMember"/);
    expect(SOURCE).toMatch(/public\.member\b/);
  });

  it("createProjectAction contains membership guard for team and organization (IDOR protection)", () => {
    // Extract the source slice starting at the createProjectAction declaration.
    // This ensures the membership-check SQL is inside the action function, not
    // only in the page-level dropdown-population queries.
    const fnStart = SOURCE.indexOf("async function createProjectAction");
    expect(fnStart).toBeGreaterThan(-1);

    // Find the closing of the action body by locating the export default line
    // that starts NewProjectPage — the action ends before it.
    const pageStart = SOURCE.indexOf("export default async function NewProjectPage");
    expect(pageStart).toBeGreaterThan(fnStart);

    const actionBody = SOURCE.slice(fnStart, pageStart);

    // The IDOR guard must query teamMember for team-level ownership
    expect(actionBody).toMatch(/public\."teamMember"/);
    // The IDOR guard must query member for organization-level ownership
    expect(actionBody).toMatch(/public\.member\b/);
    // Both guards must check the session user id
    expect(actionBody).toMatch(/session\.user\.id/);
  });

  it("imports projectsDb and projects from projects-store", () => {
    expect(SOURCE).toMatch(/from\s+"@\/lib\/projects-store"/);
    expect(SOURCE).toMatch(/projectsDb/);
  });

  it("imports the resolveOwnerId helper and the NewProjectForm component", () => {
    expect(SOURCE).toMatch(/from\s+"\.\/resolve-owner-id"/);
    expect(SOURCE).toMatch(/resolveOwnerId/);
    expect(SOURCE).toMatch(/from\s+"\.\/new-project-form"/);
    expect(SOURCE).toMatch(/NewProjectForm/);
  });

  it("declares createProjectAction with use server INSIDE the function body, not at module level", () => {
    expect(SOURCE).toMatch(/async\s+function\s+createProjectAction/);
    // The "use server" directive must appear inside an async function body, not at file top.
    const lines = SOURCE.split("\n");
    const moduleTopUseServer = lines.slice(0, 5).join("\n");
    expect(moduleTopUseServer).not.toMatch(/^\s*"use server";\s*$/m);
    expect(SOURCE).toMatch(/createProjectAction[\s\S]*?"use server";/);
  });

  it("createProjectAction re-validates session before inserting", () => {
    // Confirm requireAuthSession appears inside the body (after the `async function createProjectAction(`).
    const fnIdx = SOURCE.indexOf("async function createProjectAction");
    const insertIdx = SOURCE.indexOf("projectsDb.insert");
    const sessionIdx = SOURCE.indexOf("requireAuthSession", fnIdx);
    expect(fnIdx).toBeGreaterThan(-1);
    expect(insertIdx).toBeGreaterThan(-1);
    expect(sessionIdx).toBeGreaterThan(fnIdx);
    expect(sessionIdx).toBeLessThan(insertIdx);
  });

  it("createProjectAction calls resolveOwnerId and does not read an ownerId field directly (mass-assignment defense)", () => {
    expect(SOURCE).toMatch(/resolveOwnerId\(\s*\{/);
    expect(SOURCE).not.toMatch(/formData\.get\(\s*"ownerId"\s*\)/);
  });

  it("createProjectAction inserts via projectsDb.insert(projects).values({...}) with crypto.randomUUID()", () => {
    expect(SOURCE).toMatch(/projectsDb\.insert\(\s*projects\s*\)/);
    expect(SOURCE).toMatch(/crypto\.randomUUID\(\)/);
  });

  it("createProjectAction redirects to /projects/[id] on success", () => {
    expect(SOURCE).toMatch(/redirect\(\s*`\/projects\/\$\{[^`]*\}`/);
  });

  it("never has 'use server' at module top", () => {
    expect(SOURCE).not.toMatch(/^"use server";/m);
  });
});

describe("createProjectAction team-owner authorization (cinatra#1499 regression)", () => {
  // Slice the action body so assertions target the server action, not the
  // page-level dropdown queries.
  const fnStart = SOURCE.indexOf("async function createProjectAction");
  const pageStart = SOURCE.indexOf("export default async function NewProjectPage");
  const actionBody = SOURCE.slice(fnStart, pageStart);

  it("has an extractable createProjectAction body", () => {
    expect(fnStart).toBeGreaterThan(-1);
    expect(pageStart).toBeGreaterThan(fnStart);
  });

  it("team-membership check selects a real teamMember column (id), matching the live Better Auth schema", () => {
    // Better Auth's public.\"teamMember\" table is id/teamId/userId/createdAt.
    expect(actionBody).toMatch(/SELECT\s+id\s+FROM\s+public\."teamMember"/);
  });

  it("NEVER selects a non-existent `role` column from teamMember (the root cause of #1499)", () => {
    // The original bug: `SELECT role FROM public.\"teamMember\"` — Postgres
    // errored 'column \"role\" does not exist', surfacing as a generic
    // DB-unreachable toast. Guard against any teamMember query re-introducing
    // a role selection.
    expect(actionBody).not.toMatch(/SELECT\s+role\s+FROM\s+public\."teamMember"/);
    // The removed local that derived team-admin from that column must be gone.
    expect(actionBody).not.toMatch(/teamMemberRole/);
    expect(actionBody).not.toMatch(/===\s*"admin"\s*\?\s*"team_admin"/);
  });

  it("authorizes team-owned creation on plain MEMBERSHIP (existence), not a team role", () => {
    // Membership decision is existence-based (rows present), not role-based.
    expect(actionBody).toMatch(/isTeamMember\s*=\s*memberRows\.rows\.length\s*>\s*0/);
    // A confirmed member is mapped to the org-member role so the kernel's
    // `project.create` (granted to `member`) gate passes.
    expect(actionBody).toMatch(/enrichedRoles\.push\("member"\)/);
  });

  it("denies a non-member with a permission-style error redirect (not the generic DB toast)", () => {
    expect(actionBody).toMatch(/error=not-a-team-member/);
  });

  it("leaves the org-owned path querying public.member.role unchanged (member DOES have a role column)", () => {
    expect(actionBody).toMatch(/SELECT\s+role\s+FROM\s+public\.member\b/);
  });
});
