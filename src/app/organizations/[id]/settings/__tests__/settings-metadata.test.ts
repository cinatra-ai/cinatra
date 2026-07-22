/**
 * `/organizations/[id]/settings` gate-repeating metadata (cinatra#1734,
 * #1737 pattern): the tab title must repeat the membership gate before
 * disclosing the org name — a non-member (or anonymous) crawler gets the
 * generic title even though the page itself 404s (codex round: metadata
 * gate parity pinned).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  getAuthSession: vi.fn(),
  isMember: vi.fn(),
  execute: vi.fn(),
}));

vi.mock("@/lib/auth-session", () => ({ getAuthSession: h.getAuthSession }));
vi.mock("@/lib/better-auth-db", () => ({
  betterAuthDb: { execute: h.execute },
  readUserIsOrgMember: h.isMember,
}));

import { generateMetadata } from "../page";

const PARAMS = { params: Promise.resolve({ id: "org-1" }) };

beforeEach(() => {
  h.getAuthSession.mockReset();
  h.isMember.mockReset();
  h.execute.mockReset();
});

describe("org settings metadata gate (#1734)", () => {
  it("anonymous → generic title, no membership or name reads", async () => {
    h.getAuthSession.mockResolvedValue(null);
    await expect(generateMetadata(PARAMS)).resolves.toEqual({
      title: "Organization settings",
    });
    expect(h.isMember).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("non-member → generic title, name never read", async () => {
    h.getAuthSession.mockResolvedValue({ user: { id: "stranger" } });
    h.isMember.mockResolvedValue(false);
    await expect(generateMetadata(PARAMS)).resolves.toEqual({
      title: "Organization settings",
    });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("member → name-bearing title", async () => {
    h.getAuthSession.mockResolvedValue({ user: { id: "u1" } });
    h.isMember.mockResolvedValue(true);
    h.execute.mockResolvedValue({ rows: [{ name: "Acme Inc" }] });
    await expect(generateMetadata(PARAMS)).resolves.toEqual({
      title: "Organization settings — Acme Inc",
    });
  });

  it("read failure → generic title (never throws)", async () => {
    h.getAuthSession.mockResolvedValue({ user: { id: "u1" } });
    h.isMember.mockRejectedValue(new Error("pg down"));
    await expect(generateMetadata(PARAMS)).resolves.toEqual({
      title: "Organization settings",
    });
  });
});
