// The user avatar helper (cinatra#4292): the accent ground and the initials of
// a person's avatar fallback.
//
// The drawing (specs/app-components.html, Avatar): "User avatars carry the
// user's initials in Archivo italic 800 on a random categorical accent (never
// indigo or navy)". This file pins the helper's half of that sentence: the
// accent is a categorical palette name (a valid persisted one first, else one
// derived from the stable user id), and the initials come from the name, then
// from the e-mail, and never come out blank.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ACCENT_PALETTE, EXTENSION_ACCENTS } from "../lib/extension-accent";
import { userAvatarAccent, userInitials } from "../lib/user-avatar";

const PKG_DIR = join(__dirname, "..", "..");
const REPO_ROOT = join(PKG_DIR, "..", "..");

describe("userAvatarAccent", () => {
  it("keeps a valid persisted accent", () => {
    for (const accent of EXTENSION_ACCENTS) {
      expect(userAvatarAccent({ id: "user-1", accentColor: accent })).toBe(accent);
    }
  });

  it("derives the accent from the stable id when none is persisted or the stored one is not a palette name", () => {
    const derived = userAvatarAccent({ id: "user-1" });
    expect(EXTENSION_ACCENTS).toContain(derived);
    expect(userAvatarAccent({ id: "user-1", accentColor: null })).toBe(derived);
    expect(userAvatarAccent({ id: "user-1", accentColor: "indigo" })).toBe(derived);
    expect(userAvatarAccent({ id: "user-1", accentColor: "navy" })).toBe(derived);
    expect(userAvatarAccent({ id: "user-1", accentColor: "" })).toBe(derived);
  });

  it("gives one person the same accent on every call", () => {
    const id = "6f1c2a7e-9b1d-4c8e-a2f3-0d4e5b6c7a8f";
    expect(userAvatarAccent({ id })).toBe(userAvatarAccent({ id }));
  });

  it("spreads different people over more than one accent", () => {
    const seen = new Set(
      Array.from({ length: 40 }, (_, i) => userAvatarAccent({ id: `user-${i}` })),
    );
    expect(seen.size).toBeGreaterThan(1);
  });

  it("returns an accent even with no id at all", () => {
    expect(EXTENSION_ACCENTS).toContain(userAvatarAccent({}));
    expect(EXTENSION_ACCENTS).toContain(userAvatarAccent({ email: "ada@example.com" }));
  });

  it("never yields indigo or navy", () => {
    const names = EXTENSION_ACCENTS as readonly string[];
    expect(names).not.toContain("indigo");
    expect(names).not.toContain("navy");
    for (let i = 0; i < 100; i++) {
      const accent = userAvatarAccent({ id: `person-${i}` });
      expect(ACCENT_PALETTE[accent]).toBeDefined();
    }
  });
});

describe("userInitials", () => {
  it("takes the first letters of the first and the last word of the name", () => {
    expect(userInitials({ name: "Ada Lovelace" })).toBe("AL");
    expect(userInitials({ name: "  ada   byron   lovelace " })).toBe("AL");
  });

  it("takes one letter from a one-word name", () => {
    expect(userInitials({ name: "Ada" })).toBe("A");
  });

  it("falls back to the e-mail when the name is empty or missing", () => {
    expect(userInitials({ name: "", email: "ada.lovelace@example.com" })).toBe("AL");
    expect(userInitials({ name: "   ", email: "grace_hopper@example.com" })).toBe("GH");
    expect(userInitials({ email: "linus@example.com" })).toBe("L");
    expect(userInitials({ name: null, email: "first-last+tag@example.com" })).toBe("FT");
  });

  it("prefers the name over the e-mail", () => {
    expect(userInitials({ name: "Grace Hopper", email: "ada@example.com" })).toBe("GH");
  });

  it("never returns a blank: the fallback stands in when nothing gives a letter", () => {
    expect(userInitials({})).toBe("?");
    expect(userInitials({ name: "", email: "" })).toBe("?");
    expect(userInitials({ name: null, email: "@example.com" })).toBe("?");
    expect(userInitials({}, "Me")).toBe("Me");
  });

  it("keeps a letter outside the basic plane whole", () => {
    expect(userInitials({ name: "\u{1D400}da Lovelace" })).toBe("\u{1D400}L");
  });
});

describe("where the helper lives", () => {
  it("is a subpath export of the shared UI package, not a root-barrel export", () => {
    const pkg = JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8")) as {
      exports: Record<string, string>;
    };
    expect(pkg.exports["./lib/user-avatar"]).toBe("./src/lib/user-avatar.ts");
    const indexSrc = readFileSync(join(PKG_DIR, "src", "index.ts"), "utf8");
    expect(indexSrc).not.toMatch(/user-avatar/);
  });

  it("is re-exported, not copied, by the app's src/lib/user-avatar.ts", () => {
    const appSrc = readFileSync(join(REPO_ROOT, "src", "lib", "user-avatar.ts"), "utf8");
    expect(appSrc).toMatch(/from "@cinatra-ai\/sdk-ui\/lib\/user-avatar"/);
    expect(appSrc).toMatch(/userAvatarAccent/);
    expect(appSrc).toMatch(/userInitials/);
    expect(appSrc).not.toMatch(/function /);
  });
});
