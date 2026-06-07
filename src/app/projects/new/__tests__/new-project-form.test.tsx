import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import * as Mod from "@/app/projects/new/new-project-form";

const SOURCE = readFileSync("src/app/projects/new/new-project-form.tsx", "utf-8");

describe("NewProjectForm client component", () => {
  it("starts with the use client directive", () => {
    expect(SOURCE.split("\n")[0].trim()).toBe('"use client";');
  });

  it("imports react-hook-form, zod, and zodResolver", () => {
    expect(SOURCE).toMatch(/from\s+"react-hook-form"/);
    expect(SOURCE).toMatch(/from\s+"@hookform\/resolvers\/zod"/);
    expect(SOURCE).toMatch(/from\s+"zod"/);
    expect(SOURCE).toMatch(/zodResolver/);
  });

  it("imports the shadcn Form family", () => {
    expect(SOURCE).toMatch(/from\s+"@\/components\/ui\/form"/);
    expect(SOURCE).toMatch(/\bForm\b/);
    expect(SOURCE).toMatch(/\bFormField\b/);
    expect(SOURCE).toMatch(/\bFormItem\b/);
    expect(SOURCE).toMatch(/\bFormLabel\b/);
    expect(SOURCE).toMatch(/\bFormControl\b/);
    expect(SOURCE).toMatch(/\bFormMessage\b/);
  });

  it("imports RadioGroup, Select, Input, Textarea, Button", () => {
    expect(SOURCE).toMatch(/from\s+"@\/components\/ui\/radio-group"/);
    expect(SOURCE).toMatch(/from\s+"@\/components\/ui\/select"/);
    expect(SOURCE).toMatch(/from\s+"@\/components\/ui\/input"/);
    expect(SOURCE).toMatch(/from\s+"@\/components\/ui\/textarea"/);
    expect(SOURCE).toMatch(/from\s+"@\/components\/ui\/button"/);
  });

  it("imports the toast wrapper for unexpected server errors", () => {
    // Unexpected server errors route through the app toast wrapper.
    expect(SOURCE).toMatch(/from\s+"@\/lib\/cinatra-toast"/);
    expect(SOURCE).toMatch(/toast\.error/);
  });

  it("declares a zod discriminatedUnion on ownerLevel", () => {
    expect(SOURCE).toMatch(/z\.discriminatedUnion\(\s*"ownerLevel"/);
    expect(SOURCE).toMatch(/z\.literal\(\s*"user"\s*\)/);
    expect(SOURCE).toMatch(/z\.literal\(\s*"team"\s*\)/);
    expect(SOURCE).toMatch(/z\.literal\(\s*"organization"\s*\)/);
  });

  it("requires teamId on the team branch and organizationId on the organization branch", () => {
    expect(SOURCE).toMatch(/teamId:\s*z\.string\(\)\.min\(1/);
    expect(SOURCE).toMatch(/organizationId:\s*z\.string\(\)\.min\(1/);
  });

  it("uses form.watch (or equivalent) on ownerLevel for conditional rendering", () => {
    expect(SOURCE).toMatch(/\.watch\(\s*"ownerLevel"\s*\)/);
  });

  it("guards against redirect errors in the onSubmit catch (Pitfall 1)", () => {
    expect(SOURCE).toMatch(/NEXT_REDIRECT|isRedirectError/);
  });

  it("exports a named NewProjectForm component", () => {
    expect(typeof Mod.NewProjectForm).toBe("function");
  });

  it("contains the required copy strings verbatim", () => {
    expect(SOURCE).toContain("Project name");
    expect(SOURCE).toContain("Description");
    expect(SOURCE).toContain("Ownership level");
    expect(SOURCE).toContain("Visibility");
    expect(SOURCE).toContain("Just me");
    expect(SOURCE).toContain("A team");
    expect(SOURCE).toContain("The organization");
    expect(SOURCE).toContain("Private");
    expect(SOURCE).toContain("Discoverable");
    expect(SOURCE).toContain("Create project");
    expect(SOURCE).toContain("Cancel");
    expect(SOURCE).toContain("Enter a project name to continue.");
    expect(SOURCE).toContain("Pick a team to own this project, or change the ownership level.");
    expect(SOURCE).toContain("Pick an organization to own this project, or change the ownership level.");
  });
});
