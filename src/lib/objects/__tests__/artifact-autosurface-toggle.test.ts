// Auto-surface toggle read seam (epic #1883 slice A6, Ruling 2 escape hatch).

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _resetArtifactAutoSurfaceToggleForTests,
  isArtifactAutoSurfaceDisabled,
  setArtifactAutoSurfaceDisabled,
} from "@/lib/objects/artifact-autosurface-toggle";

const ORG = "org-1";
const OTHER = "org-2";

beforeEach(() => {
  delete process.env.CINATRA_ARTIFACT_AUTOSURFACE_DISABLED;
  _resetArtifactAutoSurfaceToggleForTests();
});
afterEach(() => {
  delete process.env.CINATRA_ARTIFACT_AUTOSURFACE_DISABLED;
  _resetArtifactAutoSurfaceToggleForTests();
});

describe("default", () => {
  it("auto-surface is ON by default (not disabled)", () => {
    expect(isArtifactAutoSurfaceDisabled(ORG)).toBe(false);
  });
});

describe("process-local override", () => {
  it("a per-org override disables (and clears back to the default)", () => {
    setArtifactAutoSurfaceDisabled(ORG, true);
    expect(isArtifactAutoSurfaceDisabled(ORG)).toBe(true);
    expect(isArtifactAutoSurfaceDisabled(OTHER)).toBe(false);
    setArtifactAutoSurfaceDisabled(ORG, null);
    expect(isArtifactAutoSurfaceDisabled(ORG)).toBe(false);
  });

  it("an override wins over the env default", () => {
    process.env.CINATRA_ARTIFACT_AUTOSURFACE_DISABLED = "all";
    setArtifactAutoSurfaceDisabled(ORG, false);
    expect(isArtifactAutoSurfaceDisabled(ORG)).toBe(false); // override beats env "all"
    expect(isArtifactAutoSurfaceDisabled(OTHER)).toBe(true); // env still applies
  });
});

describe("env default", () => {
  it("'all' / '1' / 'true' disables for every org", () => {
    for (const v of ["all", "1", "true"]) {
      _resetArtifactAutoSurfaceToggleForTests();
      process.env.CINATRA_ARTIFACT_AUTOSURFACE_DISABLED = v;
      expect(isArtifactAutoSurfaceDisabled(ORG)).toBe(true);
      expect(isArtifactAutoSurfaceDisabled(OTHER)).toBe(true);
    }
  });

  it("a comma-separated list disables only the named orgs", () => {
    process.env.CINATRA_ARTIFACT_AUTOSURFACE_DISABLED = " org-1 , org-3 ";
    expect(isArtifactAutoSurfaceDisabled(ORG)).toBe(true);
    expect(isArtifactAutoSurfaceDisabled("org-3")).toBe(true);
    expect(isArtifactAutoSurfaceDisabled(OTHER)).toBe(false);
  });
});
