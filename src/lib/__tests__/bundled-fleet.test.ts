// The image fleet marker's READER (src/lib/bundled-fleet.ts).
//
// The contract this pins is the one the boot decision rests on: a marker that
// says `dev` is read as `dev`, and EVERY other outcome — no file, a truncated
// file, a document of the wrong shape, a fleet name nobody writes — reads as
// `required`, which is the deployment road's seed set. A boot must never widen
// its catalogue because a file was unreadable.
//
// Mirrors the sibling reader's suite shape (bundled-digests): real fs, a temp
// directory, no host.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  BUNDLED_FLEET_DEV,
  BUNDLED_FLEET_REQUIRED,
  DEFAULT_BUNDLED_FLEET_PATH,
  readBundledFleet,
} from "@/lib/bundled-fleet";

let dir: string;
let marker: string;

const write = (body: string) => writeFileSync(marker, body);

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "bundled-fleet-"));
  marker = path.join(dir, ".cinatra-extension-fleet.json");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("readBundledFleet", () => {
  it("reads a dev-fleet image's marker as the dev fleet", () => {
    write(JSON.stringify({ formatVersion: 1, fleet: BUNDLED_FLEET_DEV }));
    expect(readBundledFleet(marker)).toBe(BUNDLED_FLEET_DEV);
  });

  it("reads a required-only image's marker as the required fleet", () => {
    write(JSON.stringify({ formatVersion: 1, fleet: BUNDLED_FLEET_REQUIRED }));
    expect(readBundledFleet(marker)).toBe(BUNDLED_FLEET_REQUIRED);
  });

  it("absent file (dev boot, or an image built before the marker existed) → required, silently", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(readBundledFleet(path.join(dir, "nothing-here.json"))).toBe(BUNDLED_FLEET_REQUIRED);
    expect(warn).not.toHaveBeenCalled();
  });

  it("malformed JSON → loud warn + required", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    write("{ not json");
    expect(readBundledFleet(marker)).toBe(BUNDLED_FLEET_REQUIRED);
    expect(warn).toHaveBeenCalled();
  });

  it("wrong formatVersion → loud warn + required", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    write(JSON.stringify({ formatVersion: 2, fleet: BUNDLED_FLEET_DEV }));
    expect(readBundledFleet(marker)).toBe(BUNDLED_FLEET_REQUIRED);
    expect(warn).toHaveBeenCalled();
  });

  it("an unknown fleet name is never honoured → loud warn + required", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    write(JSON.stringify({ formatVersion: 1, fleet: "everything" }));
    expect(readBundledFleet(marker)).toBe(BUNDLED_FLEET_REQUIRED);
    expect(warn).toHaveBeenCalled();
  });

  // The fleet is a property of the IMAGE, not of the environment a container
  // was started with: the marker decides whether a boot widens its catalogue
  // and writes agent rows, so no environment value may relocate it. A
  // deployment that sets a path variable must still read its own image.
  it("no environment variable can relocate the marker — the image-baked path is the only one", () => {
    write(JSON.stringify({ formatVersion: 1, fleet: BUNDLED_FLEET_DEV }));
    vi.stubEnv("CINATRA_BUNDLED_FLEET_PATH", marker);
    vi.stubEnv("CINATRA_EXTENSION_FLEET", BUNDLED_FLEET_DEV);
    // Nothing is read from the temp marker: the default path does not exist on
    // this host, so the deployment road is what comes back.
    expect(readBundledFleet()).toBe(BUNDLED_FLEET_REQUIRED);
  });

  it("the image-baked default path is the one the Dockerfile runtime stage copies to", () => {
    expect(DEFAULT_BUNDLED_FLEET_PATH).toBe("/app/.cinatra-extension-fleet.json");
  });
});
