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

  it("createProjectAction re-validates session before inserting (V2)", () => {
    // Confirm requireAuthSession appears inside the body (after the `async function createProjectAction(`).
    const fnIdx = SOURCE.indexOf("async function createProjectAction");
    const insertIdx = SOURCE.indexOf("projectsDb.insert");
    const sessionIdx = SOURCE.indexOf("requireAuthSession", fnIdx);
    expect(fnIdx).toBeGreaterThan(-1);
    expect(insertIdx).toBeGreaterThan(-1);
    expect(sessionIdx).toBeGreaterThan(fnIdx);
    expect(sessionIdx).toBeLessThan(insertIdx);
  });

  it("createProjectAction calls resolveOwnerId and does not read an ownerId field directly (V5 mass-assignment defense)", () => {
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
