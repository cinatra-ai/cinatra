/**
 * The extension SDK declares the HOST-SHARED DESIGN PRIMITIVES as its host peer
 * (cinatra#3471 item 2: "the extension SDK declares it as a peer").
 *
 * The module id is VIRTUAL: the host serves it at run time and no package is
 * published under it, so an npm specifier (a dependency, or a peer, optional
 * or not) makes `pnpm install` resolve the id and fail. The SDK therefore
 * declares the peer in its `cinatra` block, `cinatra.hostServedPeers`: the
 * module id and the contract range the SDK is built against. This file pins
 * that declaration to the contract constants, so a contract bump that does not
 * move the declaration fails here, and pins that no npm field names the id.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  HOST_DESIGN_PRIMITIVES_CONTRACT_MAJOR,
  HOST_DESIGN_PRIMITIVES_CONTRACT_VERSION,
  HOST_DESIGN_PRIMITIVES_MODULE,
  checkDesignPrimitivesContract,
  designPrimitivesContractMajorOf,
} from "../design-primitives-contract";

const PACKAGE_JSON = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");

type SdkPackageJson = {
  cinatra?: { hostServedPeers?: Record<string, unknown> };
  [field: string]: unknown;
};

function readSdkPackageJson(): SdkPackageJson {
  return JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as SdkPackageJson;
}

describe("the SDK's host peer declaration for the shared design primitives", () => {
  it("names the host-shared module with a caret range on the served contract version", () => {
    const peers = readSdkPackageJson().cinatra?.hostServedPeers;
    // red-first-expect: expected undefined to deeply equal
    expect(peers).toEqual({
      [HOST_DESIGN_PRIMITIVES_MODULE]: `^${HOST_DESIGN_PRIMITIVES_CONTRACT_VERSION}`,
    });
  });

  it("declares a range whose major is the contract major the host serves", () => {
    const range = readSdkPackageJson().cinatra?.hostServedPeers?.[HOST_DESIGN_PRIMITIVES_MODULE];
    // red-first-expect: expected 'undefined' to be 'string'
    expect(typeof range).toBe("string");
    const version = String(range).replace(/^\^/, "");
    expect(designPrimitivesContractMajorOf(version)).toBe(HOST_DESIGN_PRIMITIVES_CONTRACT_MAJOR);
    expect(checkDesignPrimitivesContract({ builtAgainst: version })).toBeNull();
  });

  it("is the range the load-time check requires of a bundle built with this SDK", () => {
    // A bundle built with this SDK declares HOST_DESIGN_PRIMITIVES_CONTRACT_VERSION
    // in its preamble; the check then requires exactly the declared range of the
    // host. The range is read from package.json, never restated here.
    const range = readSdkPackageJson().cinatra?.hostServedPeers?.[HOST_DESIGN_PRIMITIVES_MODULE];
    // red-first-expect: expected 'undefined' to be 'string'
    expect(typeof range).toBe("string");
    const floor = String(range).replace(/^\^/, "");
    expect(floor).toBe(HOST_DESIGN_PRIMITIVES_CONTRACT_VERSION);
    // A host below the declared range is refused, naming the declared range.
    const refusal = checkDesignPrimitivesContract({ builtAgainst: floor, hostServes: "1.0.0" });
    expect(refusal).toContain(`requires "${String(range)}", but this host serves 1.0.0`);
    // A host at the floor or above inside the major is admitted.
    expect(checkDesignPrimitivesContract({ builtAgainst: floor, hostServes: floor })).toBeNull();
    expect(checkDesignPrimitivesContract({ builtAgainst: floor, hostServes: "1.9.0" })).toBeNull();
  });

  it("never names the virtual id in an npm dependency field", () => {
    const pkg = readSdkPackageJson();
    for (const field of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
      "peerDependenciesMeta",
    ]) {
      const entries = (pkg[field] ?? {}) as Record<string, unknown>;
      expect(Object.keys(entries), field).not.toContain(HOST_DESIGN_PRIMITIVES_MODULE);
    }
  });
});
