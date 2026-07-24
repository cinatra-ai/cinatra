// The fs leaf that reads a pack's `form:"dashboard"` template + sidecar config off
// disk (cinatra#1896 Scope 2 trigger). Real temp-dir fixtures — no mocks — so the
// manifest parse, the sidecar read, the default-variant pick, and the traversal
// guard are all exercised against real files.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  readPackDashboardTemplate,
  packShipsDashboardTemplate,
  readPackDashboardTemplateFromDir,
  packShipsDashboardTemplateInDir,
} from "../read-pack-dashboard-template";

// The reader resolves `sourceDir` against process.cwd(); pin cwd to a temp root so
// the relative sourceDir maps to our fixture tree.
let root: string;
let prevCwd: string;

function writePack(sourceRel: string, manifest: unknown, sidecar?: { rel: string; body: unknown }) {
  const dir = path.join(root, sourceRel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify(manifest));
  if (sidecar) {
    const p = path.join(dir, sidecar.rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(sidecar.body));
  }
}

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "pack-tmpl-"));
  prevCwd = process.cwd();
  process.chdir(root);
});
afterAll(() => {
  process.chdir(prevCwd);
  rmSync(root, { recursive: true, force: true });
});

const SRC = "extensions/cinatra-ai/web-analytics-dashboard-artifact";
const DASH = { apiVersion: "v1.2", scopeLevel: "organization", portlets: [] };

describe("readPackDashboardTemplate", () => {
  it("reads the default form:dashboard template's sidecar config + display name", () => {
    writePack(
      SRC,
      {
        name: "@cinatra-ai/web-analytics-dashboard-artifact",
        displayName: "top-level ignored",
        cinatra: {
          kind: "artifact",
          displayName: "Web Analytics Dashboard",
          artifact: {
            accepts: { dashboard: true },
            templates: [
              { id: "other", form: "file", mimeType: "text/markdown", path: "./x.md" },
              { id: "wa", form: "dashboard", mimeType: "application/vnd.cinatra.dashboard.v12+json", path: "./cinatra/dashboard.json", default: true },
            ],
          },
        },
      },
      { rel: "cinatra/dashboard.json", body: DASH },
    );
    expect(packShipsDashboardTemplate("pkg", SRC)).toBe(true);
    const r = readPackDashboardTemplate("pkg", SRC);
    expect(r).not.toBeNull();
    expect(r!.config).toEqual(DASH);
    // The pack's cinatra.displayName drives the row name (not the top-level one).
    expect(r!.name).toBe("Web Analytics Dashboard dashboard");
  });

  it("returns null for a pack with no dashboard template", () => {
    const S = "extensions/cinatra-ai/no-dash";
    writePack(S, { cinatra: { kind: "artifact", artifact: { templates: [{ id: "f", form: "file", path: "./x.md" }] } } });
    expect(packShipsDashboardTemplate("pkg", S)).toBe(false);
    expect(readPackDashboardTemplate("pkg", S)).toBeNull();
  });

  it("returns null when the pack dir is absent (unreadable package.json)", () => {
    expect(readPackDashboardTemplate("pkg", "extensions/cinatra-ai/ghost")).toBeNull();
  });

  it("returns null when the sidecar body is missing", () => {
    const S = "extensions/cinatra-ai/missing-sidecar";
    writePack(S, { cinatra: { kind: "artifact", artifact: { templates: [{ id: "wa", form: "dashboard", path: "./cinatra/dashboard.json", default: true }] } } });
    // No sidecar written.
    expect(readPackDashboardTemplate("pkg", S)).toBeNull();
  });

  it("rejects a template path that escapes the pack dir (traversal guard)", () => {
    const S = "extensions/cinatra-ai/evil";
    writePack(S, { cinatra: { kind: "artifact", artifact: { templates: [{ id: "x", form: "dashboard", path: "../../../etc/passwd", default: true }] } } });
    expect(readPackDashboardTemplate("pkg", S)).toBeNull();
  });
});

// --- runtime-store variant: read from an ABSOLUTE storeDir (cinatra#1896) ------
// A MARKETPLACE-installed pack lives in the runtime package store at an absolute
// `<data>/artifact/<slug>/<digest>/` dir (NOT a cwd-relative sourceDir). The
// FromDir variants read + guard against that absolute root directly.
describe("readPackDashboardTemplateFromDir (runtime store, absolute dir)", () => {
  it("reads the dashboard template from an absolute store dir", () => {
    const storeDir = path.join(root, "data/extensions/artifact/web-analytics/deadbeefcafe");
    mkdirSync(storeDir, { recursive: true });
    writeFileSync(
      path.join(storeDir, "package.json"),
      JSON.stringify({
        name: "@cinatra-ai/web-analytics-dashboard-artifact",
        cinatra: {
          kind: "artifact",
          displayName: "Web Analytics Dashboard",
          artifact: { templates: [{ id: "wa", form: "dashboard", path: "./cinatra/dashboard.json", default: true }] },
        },
      }),
    );
    mkdirSync(path.join(storeDir, "cinatra"), { recursive: true });
    writeFileSync(path.join(storeDir, "cinatra/dashboard.json"), JSON.stringify(DASH));

    expect(packShipsDashboardTemplateInDir("pkg", storeDir)).toBe(true);
    const r = readPackDashboardTemplateFromDir("pkg", storeDir);
    expect(r).not.toBeNull();
    expect(r!.config).toEqual(DASH);
    expect(r!.name).toBe("Web Analytics Dashboard dashboard");
  });

  it("preserves the traversal guard against an absolute store dir root", () => {
    const storeDir = path.join(root, "data/extensions/artifact/evil/abc123");
    mkdirSync(storeDir, { recursive: true });
    writeFileSync(
      path.join(storeDir, "package.json"),
      JSON.stringify({
        name: "@x/evil",
        cinatra: { kind: "artifact", artifact: { templates: [{ id: "x", form: "dashboard", path: "../../../../../../etc/passwd", default: true }] } },
      }),
    );
    expect(readPackDashboardTemplateFromDir("pkg", storeDir)).toBeNull();
  });
});
