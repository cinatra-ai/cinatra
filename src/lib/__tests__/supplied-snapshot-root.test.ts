/**
 * WHERE A SUPPLIED SNAPSHOT IS STAGED (cinatra#3204 leg 3).
 *
 * The supplied road stages the operator's bytes before anything is installed,
 * and it stages them onto the host's extension volume. Leg 1 wrote the resolver
 * with a fixed "/data/extension-uploads" default, while its own docstring
 * promised "the default sits beside the extension data root the store already
 * uses" — so a deployment (or a development host, or a CI job) whose extension
 * data root is anywhere else got a supplied-install road pointed at a directory
 * nothing else on the host owns, and every upload of every kind died on the
 * mkdir with a raw EACCES that reached the operator as the whole answer.
 *
 * This pins the precedence the docstring always described.
 */
import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";

import { resolveSuppliedSnapshotRoot } from "@/lib/extension-package-store";

const SNAPSHOT_ROOT = "CINATRA_SUPPLIED_SNAPSHOT_ROOT";
const DATA_ROOT = "CINATRA_EXTENSION_DATA_ROOT";

const saved = {
  snapshot: process.env[SNAPSHOT_ROOT],
  data: process.env[DATA_ROOT],
};

function set(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  set(SNAPSHOT_ROOT, saved.snapshot);
  set(DATA_ROOT, saved.data);
});

describe("resolveSuppliedSnapshotRoot", () => {
  it("an explicit snapshot root wins over everything else", () => {
    set(SNAPSHOT_ROOT, "/srv/uploads");
    set(DATA_ROOT, "/mnt/volume/extensions");
    expect(resolveSuppliedSnapshotRoot()).toBe(path.resolve("/srv/uploads"));
  });

  it("with no explicit root, the snapshots sit BESIDE the configured extension data root", () => {
    set(SNAPSHOT_ROOT, undefined);
    set(DATA_ROOT, "/mnt/volume/extensions");
    expect(resolveSuppliedSnapshotRoot()).toBe("/mnt/volume/extension-uploads");
  });

  it("a relative data root resolves against the working directory first", () => {
    set(SNAPSHOT_ROOT, undefined);
    set(DATA_ROOT, ".lane/extensions");
    expect(resolveSuppliedSnapshotRoot()).toBe(
      path.join(path.resolve(".lane"), "extension-uploads"),
    );
  });

  it("an empty or whitespace-only setting is not a setting", () => {
    set(SNAPSHOT_ROOT, "   ");
    set(DATA_ROOT, "");
    expect(resolveSuppliedSnapshotRoot()).toBe(path.resolve("/data/extension-uploads"));
  });

  it("with nothing configured, the container default is unchanged", () => {
    set(SNAPSHOT_ROOT, undefined);
    set(DATA_ROOT, undefined);
    expect(resolveSuppliedSnapshotRoot()).toBe(path.resolve("/data/extension-uploads"));
  });
});
