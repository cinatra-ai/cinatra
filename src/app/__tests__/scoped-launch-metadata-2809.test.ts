/**
 * THE SCOPED SURFACE\x27S TAB TITLE (cinatra#2809, per-scope surfaces S3 — the
 * ratified drawing, Components/Breadcrumb: "The browser-tab title mirrors the
 * resolved trail under the same rules: an id-bearing route never shows a raw
 * id in the tab.").
 *
 * Every scoped launch route is id-bearing, and the shell deliberately writes
 * no title on an id-bearing route before the trail resolves — so the route\x27s
 * OWN metadata is what the tab reads until then. A static "Agent" mirrors
 * nothing. This pins the gate-repeating title that names the scope, and pins
 * that it falls back to the surface noun rather than to any form of the id.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const h = vi.hoisted(() => ({ readName: vi.fn() }));
vi.mock("@/lib/scope-surface-entity-name", () => ({
  readScopeSurfaceEntityName: h.readName,
}));

import { scopedSurfaceMetadata } from "@/app/scoped-launch-routes";


describe("cinatra#2809 — the scoped launch route\x27s tab title", () => {
  it("names the scope the trail names", async () => {
    h.readName.mockResolvedValue("Northwind Labs");
    await expect(
      scopedSurfaceMetadata({ kind: "organization", id: "9c0dfce6-aaaa" }, "Agents"),
    ).resolves.toEqual({ title: "Agents — Northwind Labs" });
  });

  it("names the assistants surface under the same rule", async () => {
    h.readName.mockResolvedValue("Growth");
    await expect(
      scopedSurfaceMetadata({ kind: "team", id: "t1" }, "Assistants"),
    ).resolves.toEqual({ title: "Assistants — Growth" });
  });

  it("falls back to the surface noun where the name is withheld or unavailable — never the id", async () => {
    h.readName.mockResolvedValue(null);
    const meta = await scopedSurfaceMetadata(
      { kind: "organization", id: "9c0dfce6-1111-2222-3333-444444444444" },
      "Agents",
    );
    expect(meta).toEqual({ title: "Agents" });
    expect(JSON.stringify(meta)).not.toContain("9c0dfce6");
  });

  it("never throws the page away when the read throws", async () => {
    h.readName.mockImplementation(() => {
      throw new Error("store down");
    });
    const meta = await scopedSurfaceMetadata({ kind: "project", id: "p1" }, "Agents");
    expect(meta).toEqual({ title: "Agents" });
  });

  it("every id-bearing scoped launch route resolves its title instead of declaring a static one", () => {
    const pages = [
      "organizations/[id]/agents",
      "organizations/[id]/assistants",
      "teams/[teamId]/agents",
      "teams/[teamId]/assistants",
      "projects/[projectId]/agents",
      "projects/[projectId]/assistants",
    ];
    for (const p of pages) {
      const file = path.join(__dirname, "..", p, "[...launch]", "page.tsx");
      const src = readFileSync(file, "utf-8");
      expect(src, p).toContain("export async function generateMetadata");
      expect(src, p).toMatch(/scopedSurfaceMetadata/);
      expect(src, p).not.toMatch(/export const metadata/);
    }
  });
});
