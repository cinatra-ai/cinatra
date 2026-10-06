// docker/wayflow/compose.clone.template.yml — the per-clone WayFlow runtime is
// checked for health with a program its image carries.
//
// THE DEFECT
// `cinatra clone start` renders this template into a clone's compose file. Its
// wayflow service checked health with `node -e …`, but the image that service
// runs is built by docker/wayflow/Dockerfile FROM the official Python image,
// which has no node. Every check failed with "node: not found", the container
// never reported healthy, and anything waiting for compose's own health status
// waited in vain. The product's full docker-compose.yml checks the same image
// with `python3`; the template now does the same.
//
// WHY A SOURCE-LEVEL TEST
// Running the check for real needs a docker daemon and an image build, which
// this suite does not have. The property is a relation between two files that
// a string read pins: the first word of the template's CMD-SHELL healthcheck
// is a program the Dockerfile's final base image puts on PATH. No YAML parser,
// the same as the other compose tests here.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => readFileSync(path.join(repoRoot, rel), "utf8");

const template = read("docker/wayflow/compose.clone.template.yml");
const dockerfile = read("docker/wayflow/Dockerfile");

// The interpreters a base image puts on PATH, by image name. Only the base the
// runtime Dockerfile builds FROM is listed: another base matches nothing, so
// this test fails until the healthcheck is checked against the new image.
const INTERPRETERS_BY_BASE_IMAGE = {
  python: ["python", "python3"],
};

// The first word of the wayflow service's CMD-SHELL healthcheck command.
function healthcheckProgram(yaml) {
  const lines = yaml.split("\n");
  const start = lines.findIndex((l) => /^  wayflow:\s*$/.test(l));
  expect(start, "the template declares a wayflow service").toBeGreaterThanOrEqual(0);
  const next = lines.findIndex((l, i) => i > start && /^  [A-Za-z0-9_-]+:\s*$/.test(l));
  const service = lines
    .slice(start, next === -1 ? lines.length : next)
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
  const match = service.match(/\n {4}healthcheck:\n {6}test:\n {8}- "CMD-SHELL"\n {8}- "([^\s"]+)/);
  expect(match, "the wayflow service has a CMD-SHELL healthcheck").not.toBeNull();
  return match[1];
}

// The image name of the Dockerfile's final stage:
// `FROM [--option …] <image>[:<tag>|@<digest>] [AS <name>]`.
function finalBaseImage(text) {
  const froms = text.split("\n").filter((l) => /^FROM\s/.test(l));
  expect(froms.length, "the Dockerfile has a FROM line").toBeGreaterThan(0);
  const ref = froms[froms.length - 1]
    .split(/\s+/)
    .slice(1)
    .find((word) => !word.startsWith("--"));
  return ref.split(/[:@]/)[0];
}

describe("docker/wayflow/compose.clone.template.yml — runtime healthcheck", () => {
  it("runs an interpreter the runtime image carries", () => {
    const program = healthcheckProgram(template);
    const carried = INTERPRETERS_BY_BASE_IMAGE[finalBaseImage(dockerfile)] ?? [];
    expect(carried).toContain(program);
  });
});
