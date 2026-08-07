// Unit tests for the required-extension OAS seed builder (cinatra-ai/ops#436).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildRequiredOasSeed,
  readSeedManifest,
  SEED_MANIFEST_FILENAME,
  SEED_MARKER_FILENAME,
} from "../build-required-oas-seed.mjs";

let root;
let source;
let out;

function writeAcquiredAgent(vendor, slug, { skills = false } = {}) {
  const slugDir = path.join(source, vendor, slug);
  mkdirSync(path.join(slugDir, "cinatra"), { recursive: true });
  writeFileSync(
    path.join(slugDir, "cinatra", "oas.json"),
    JSON.stringify({ openapi: "3.1.0", info: { title: slug } }) + "\n",
  );
  writeFileSync(
    path.join(slugDir, "package.json"),
    JSON.stringify({ name: `@${vendor}/${slug}`, version: "1.2.3" }) + "\n",
  );
  // Non-projected noise that must NOT be seeded.
  mkdirSync(path.join(slugDir, "src"), { recursive: true });
  writeFileSync(path.join(slugDir, "src", "index.ts"), "export {};\n");
  if (skills) {
    mkdirSync(path.join(slugDir, "skills", slug), { recursive: true });
    writeFileSync(path.join(slugDir, "skills", slug, "SKILL.md"), "# skill\n");
  }
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "ops436-seed-"));
  source = path.join(root, "extensions");
  out = path.join(root, "seed");
  mkdirSync(source, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("buildRequiredOasSeed", () => {
  it("projects cinatra/, skills/, and package.json (and NOT src/) per agent", () => {
    writeAcquiredAgent("cinatra-ai", "planner-agent", { skills: true });
    const { slugs } = buildRequiredOasSeed({ source, out });

    expect(slugs).toEqual([{ vendor: "cinatra-ai", slug: "planner-agent" }]);
    const seeded = path.join(out, "cinatra-ai", "planner-agent");
    expect(existsSync(path.join(seeded, "cinatra", "oas.json"))).toBe(true);
    expect(existsSync(path.join(seeded, "package.json"))).toBe(true);
    expect(existsSync(path.join(seeded, "skills", "planner-agent", "SKILL.md"))).toBe(true);
    expect(existsSync(path.join(seeded, "src"))).toBe(false);
    // Ownership marker present.
    expect(existsSync(path.join(seeded, SEED_MARKER_FILENAME))).toBe(true);
  });

  it("skips non-agent dirs (no cinatra/oas.json)", () => {
    // A required connector package with no agent OAS.
    const c = path.join(source, "cinatra-ai", "openai-connector");
    mkdirSync(c, { recursive: true });
    writeFileSync(path.join(c, "package.json"), JSON.stringify({ name: "@cinatra-ai/openai-connector" }));
    writeAcquiredAgent("cinatra-ai", "planner-agent");

    const { slugs } = buildRequiredOasSeed({ source, out });
    expect(slugs).toEqual([{ vendor: "cinatra-ai", slug: "planner-agent" }]);
    expect(existsSync(path.join(out, "cinatra-ai", "openai-connector"))).toBe(false);
  });

  it("writes a manifest enumerating every seeded slug", () => {
    writeAcquiredAgent("cinatra-ai", "planner-agent");
    writeAcquiredAgent("cinatra-ai", "author-agent");
    buildRequiredOasSeed({ source, out });

    const manifest = readSeedManifest(out);
    expect(manifest.kind).toBe("required-oas-seed-manifest");
    const keys = manifest.slugs.map((s) => `${s.vendor}/${s.slug}`).sort();
    expect(keys).toEqual(["cinatra-ai/author-agent", "cinatra-ai/planner-agent"]);
  });

  it("rebuilds from scratch (a dropped agent does not linger in the seed)", () => {
    writeAcquiredAgent("cinatra-ai", "planner-agent");
    writeAcquiredAgent("cinatra-ai", "media-transcript-agent");
    buildRequiredOasSeed({ source, out });
    expect(existsSync(path.join(out, "cinatra-ai", "media-transcript-agent"))).toBe(true);

    // Drop one agent from the acquired set, rebuild.
    rmSync(path.join(source, "cinatra-ai", "media-transcript-agent"), { recursive: true, force: true });
    buildRequiredOasSeed({ source, out });
    expect(existsSync(path.join(out, "cinatra-ai", "media-transcript-agent"))).toBe(false);
    expect(existsSync(path.join(out, "cinatra-ai", "planner-agent"))).toBe(true);
  });

  it("emits an empty manifest when the source has no extensions", () => {
    rmSync(source, { recursive: true, force: true });
    const { slugs } = buildRequiredOasSeed({ source, out });
    expect(slugs).toEqual([]);
    expect(readSeedManifest(out).slugs).toEqual([]);
  });

  it("FAILS CLOSED on a symlink inside a projected subtree", () => {
    const slugDir = path.join(source, "cinatra-ai", "planner-agent");
    mkdirSync(path.join(slugDir, "cinatra"), { recursive: true });
    writeFileSync(path.join(slugDir, "cinatra", "oas.json"), JSON.stringify({ openapi: "3.1.0" }));
    // A symlink under skills/ (the pnpm-workspace hazard the seed must reject).
    mkdirSync(path.join(slugDir, "skills"), { recursive: true });
    symlinkSync("/etc/hostname", path.join(slugDir, "skills", "evil-link"));

    expect(() => buildRequiredOasSeed({ source, out })).toThrow(/symlink/);
  });

  it("FAILS CLOSED on a symlinked cinatra/ root", () => {
    const slugDir = path.join(source, "cinatra-ai", "planner-agent");
    mkdirSync(slugDir, { recursive: true });
    const realCinatra = path.join(source, "elsewhere");
    mkdirSync(realCinatra, { recursive: true });
    writeFileSync(path.join(realCinatra, "oas.json"), JSON.stringify({ openapi: "3.1.0" }));
    symlinkSync(realCinatra, path.join(slugDir, "cinatra"));
    expect(() => buildRequiredOasSeed({ source, out })).toThrow(/symlink/);
  });

  it("FAILS CLOSED on a symlinked skills/ projected root", () => {
    const slugDir = path.join(source, "cinatra-ai", "planner-agent");
    mkdirSync(path.join(slugDir, "cinatra"), { recursive: true });
    writeFileSync(path.join(slugDir, "cinatra", "oas.json"), JSON.stringify({ openapi: "3.1.0" }));
    symlinkSync("/etc", path.join(slugDir, "skills"));
    expect(() => buildRequiredOasSeed({ source, out })).toThrow(/symlink/);
  });

  it("exports stable marker + manifest filenames the materializer relies on", () => {
    expect(SEED_MARKER_FILENAME).toBe(".cinatra-required-seed.json");
    expect(SEED_MANIFEST_FILENAME).toBe("manifest.json");
    // The oas.json round-trips byte-for-byte through projection.
    writeAcquiredAgent("cinatra-ai", "planner-agent");
    const srcOas = readFileSync(
      path.join(source, "cinatra-ai", "planner-agent", "cinatra", "oas.json"),
    );
    buildRequiredOasSeed({ source, out });
    const outOas = readFileSync(path.join(out, "cinatra-ai", "planner-agent", "cinatra", "oas.json"));
    expect(outOas.equals(srcOas)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The manifest-DECLARED `cinatra.logo` asset (cinatra#2469, codex round-7).
//
// `PROJECTED_FILES` carries package.json, so without a declaration-driven copy
// the seed keeps the logo POINTER and drops its REFERENT. This seed is what the
// Dockerfile bakes for the required-agent set, so it bypasses the runtime
// materializer entirely — it is its own dangling-logo path, not a duplicate of
// the one `materialize-agent-package.test.ts` covers.
// ---------------------------------------------------------------------------
describe("buildRequiredOasSeed — the declared cinatra.logo asset (cinatra#2469)", () => {
  const LOGO_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 4h16v16H4z"/></svg>\n';

  /** Re-declare a seeded agent's package.json with a `cinatra.logo`. */
  function declareLogo(vendor, slug, logo) {
    const slugDir = path.join(source, vendor, slug);
    writeFileSync(
      path.join(slugDir, "package.json"),
      JSON.stringify({
        name: `@${vendor}/${slug}`,
        version: "1.2.3",
        cinatra: { kind: "agent", logo },
      }) + "\n",
    );
    return slugDir;
  }

  it("projects a declared top-level logo alongside the package.json that points at it", () => {
    writeAcquiredAgent("cinatra-ai", "logo-agent");
    const slugDir = declareLogo("cinatra-ai", "logo-agent", "./logo.svg");
    writeFileSync(path.join(slugDir, "logo.svg"), LOGO_SVG);

    buildRequiredOasSeed({ source, out });
    const dst = path.join(out, "cinatra-ai", "logo-agent", "logo.svg");
    expect(existsSync(dst)).toBe(true);
    expect(readFileSync(dst, "utf8")).toBe(LOGO_SVG);
    // The pointer it resolves is seeded too — pointer and referent together.
    const seededPkg = JSON.parse(
      readFileSync(path.join(out, "cinatra-ai", "logo-agent", "package.json"), "utf8"),
    );
    expect(seededPkg.cinatra.logo).toBe("./logo.svg");
  });

  it("projects a NESTED declared path (no static PROJECTED_FILES entry could)", () => {
    writeAcquiredAgent("cinatra-ai", "nested-logo-agent");
    const slugDir = declareLogo("cinatra-ai", "nested-logo-agent", "./assets/brand/mark.svg");
    mkdirSync(path.join(slugDir, "assets", "brand"), { recursive: true });
    writeFileSync(path.join(slugDir, "assets", "brand", "mark.svg"), LOGO_SVG);

    buildRequiredOasSeed({ source, out });
    expect(
      existsSync(path.join(out, "cinatra-ai", "nested-logo-agent", "assets", "brand", "mark.svg")),
    ).toBe(true);
  });

  it("seeds NOTHING extra when no logo is declared (the projection stays narrow)", () => {
    writeAcquiredAgent("cinatra-ai", "plain-agent");
    // An undeclared stray svg must not ride along.
    writeFileSync(path.join(source, "cinatra-ai", "plain-agent", "logo.svg"), LOGO_SVG);

    buildRequiredOasSeed({ source, out });
    expect(existsSync(path.join(out, "cinatra-ai", "plain-agent", "logo.svg"))).toBe(false);
    // …and the ordinary projection is untouched.
    expect(existsSync(path.join(out, "cinatra-ai", "plain-agent", "cinatra", "oas.json"))).toBe(true);
  });

  it("SKIPS an escaping / non-svg / missing declaration without failing the build", () => {
    for (const [slug, logo] of [
      ["escape-agent", "../../evil.svg"],
      ["png-agent", "./logo.png"],
      ["missing-agent", "./nope.svg"],
    ]) {
      writeAcquiredAgent("cinatra-ai", slug);
      const slugDir = declareLogo("cinatra-ai", slug, logo);
      writeFileSync(path.join(slugDir, "logo.png"), "not an svg");
    }
    // A cosmetic asset must never fail the image build.
    expect(() => buildRequiredOasSeed({ source, out })).not.toThrow();
    expect(existsSync(path.join(out, "cinatra-ai", "png-agent", "logo.png"))).toBe(false);
    expect(existsSync(path.join(out, "cinatra-ai", "escape-agent", "cinatra", "oas.json"))).toBe(true);
  });

  it("SKIPS a logo behind a symlinked PARENT dir (realpath containment)", () => {
    writeAcquiredAgent("cinatra-ai", "symlink-parent-agent");
    const slugDir = declareLogo("cinatra-ai", "symlink-parent-agent", "./assets/mark.svg");
    const outsideDir = mkdtempSync(path.join(os.tmpdir(), "seed-outside-"));
    try {
      writeFileSync(path.join(outsideDir, "mark.svg"), LOGO_SVG);
      symlinkSync(outsideDir, path.join(slugDir, "assets"));

      expect(() => buildRequiredOasSeed({ source, out })).not.toThrow();
      expect(
        existsSync(path.join(out, "cinatra-ai", "symlink-parent-agent", "assets", "mark.svg")),
      ).toBe(false);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
