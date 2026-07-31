#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Fail-closed transition-eligibility CLI over the committed upgrade matrix
// (upgrade-paths epic cinatra#1419 / cinatra#1421).
//
// Thin executable wrapper around the shared consumption contract
// (scripts/lib/upgrade-matrix.mjs): loads the matrix, asserts the pinned
// revision (skew is fail-closed), resolves the (service, from, to) tuple, and
// prints the verdict as JSON. The guarded family paths
// (scripts/upgrade/*-upgrade-major.sh) call this BEFORE any mutation and treat
// anything but exit 0 as a refusal.
//
//   node scripts/upgrade/resolve-transition.mjs <serviceId> <from> <to> [--matrix <path>]
//   node scripts/upgrade/resolve-transition.mjs --image-repo <serviceId>   # baseline image repo only
//   node scripts/upgrade/resolve-transition.mjs --pin <serviceId> [--coupled <imageRepo>] [--tag]
//
// `--pin` prints the DIGEST-BOUND image the matrix records for a service — the
// baseline engine pin, or (with `--coupled`) the coupled app image whose repo
// matches. It is the single source of truth the works-after fixtures derive
// their defaults from at RUNTIME (cinatra#2302) instead of carrying a third
// hand-synced copy of the digest that compose + the matrix already carry
// (Renovate pairs those two, cinatra#1863, but knows nothing about a fixture
// literal). `--tag` prints the `tag@sha256:…` form (repo stripped) for the
// fixtures whose env var is a TAG. A pin that is not digest-bound is a
// fail-closed refusal: a fixture default must pin bytes, never float.
//
// Exit codes:
//   0  supported transition (verdict JSON on stdout)
//   2  usage error
//   3  FAIL-CLOSED: unsupported/unknown tuple, unknown service, a missing or
//      non-digest-bound pin, or matrix revision/schema skew (verdict/diagnostic
//      on stdout/stderr)
// ---------------------------------------------------------------------------

import process from "node:process";

import {
  assertMatrixRevision,
  getService,
  loadUpgradeMatrix,
  resolveTransition,
} from "../lib/upgrade-matrix.mjs";

function usage(msg) {
  console.error(`ERROR: ${msg}`);
  console.error(
    "usage: resolve-transition.mjs <serviceId> <from> <to> [--matrix <path>] | --image-repo <serviceId> | --pin <serviceId> [--coupled <imageRepo>] [--tag]",
  );
  process.exit(2);
}

// The image REPO component of an image ref (digest- and tag-aware):
//   redis:8-alpine@sha256:…            -> redis
//   valkey/valkey:7.2.11-alpine        -> valkey/valkey
//   registry:5000/org/img@sha256:…     -> registry:5000/org/img
// The tag separator is the first colon AFTER the last slash; a colon before it
// belongs to a registry host:port. Using lastIndexOf(":") instead would shear a
// tagless ported ref down to its hostname and silently mis-resolve a --coupled
// lookup (codex round-1). No current pin carries a port, so this is a latent-bug
// fix with no value change today.
function imageRepoOf(ref) {
  const noDigest = ref.split("@")[0];
  const tagColon = noDigest.indexOf(":", noDigest.lastIndexOf("/") + 1);
  return tagColon === -1 ? noDigest : noDigest.slice(0, tagColon);
}

const argv = process.argv.slice(2);

let matrixPath;
const positional = [];
let imageRepoService = null;
let pinService = null;
let coupledRepo = null;
let tagOnly = false;
// A REPEATED value flag must never silently win last-one-wins and change WHICH
// pin is printed (codex round-1) — refuse the ambiguous invocation instead.
const seen = new Set();
const once = (flag) => {
  if (seen.has(flag)) usage(`${flag} given more than once`);
  seen.add(flag);
};
// A value that is itself a flag means the value was omitted (`--pin --tag`).
// Swallowing it would turn a typo into a confusing "unknown service '--tag'"
// instead of a usage error, so reject it here.
const valueFor = (flag, v) => {
  if (!v || v.startsWith("--")) usage(`missing value for ${flag}`);
  return v;
};
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === "--matrix") {
    once("--matrix");
    matrixPath = valueFor("--matrix", argv[i + 1]);
    i += 1;
  } else if (argv[i] === "--image-repo") {
    once("--image-repo");
    imageRepoService = valueFor("--image-repo", argv[i + 1]);
    i += 1;
  } else if (argv[i] === "--pin") {
    once("--pin");
    pinService = valueFor("--pin", argv[i + 1]);
    i += 1;
  } else if (argv[i] === "--coupled") {
    once("--coupled");
    coupledRepo = valueFor("--coupled", argv[i + 1]);
    i += 1;
  } else if (argv[i] === "--tag") {
    tagOnly = true;
  } else if (argv[i].startsWith("--")) {
    // Fail CLOSED on a typo: an unknown flag must never be swallowed as a
    // positional and silently change which value this CLI prints.
    usage(`unknown flag '${argv[i]}'`);
  } else {
    positional.push(argv[i]);
  }
}
if ((coupledRepo || tagOnly) && !pinService) usage("--coupled/--tag are only valid with --pin");
if (imageRepoService && pinService) usage("--image-repo and --pin are mutually exclusive");
// The option modes take no positionals; leftovers mean a malformed invocation.
if ((imageRepoService || pinService) && positional.length > 0) {
  usage(`unexpected argument(s) for --${imageRepoService ? "image-repo" : "pin"}: ${positional.join(" ")}`);
}

let matrix;
try {
  matrix = matrixPath ? loadUpgradeMatrix(matrixPath) : loadUpgradeMatrix();
  assertMatrixRevision(matrix);
} catch (err) {
  // Skew or unreadable matrix: fail CLOSED — a consumer must never act on a
  // matrix it was not validated against.
  console.error(`FAIL-CLOSED: ${err.message}`);
  process.exit(3);
}

if (imageRepoService) {
  const svc = getService(matrix, imageRepoService);
  if (!svc) {
    console.error(`FAIL-CLOSED: unknown matrix service '${imageRepoService}'.`);
    process.exit(3);
  }
  process.stdout.write(imageRepoOf(svc.baselinePin.image));
  process.exit(0);
}

if (pinService) {
  const svc = getService(matrix, pinService);
  if (!svc) {
    console.error(`FAIL-CLOSED: unknown matrix service '${pinService}'.`);
    process.exit(3);
  }
  let image;
  if (coupledRepo) {
    const hits = (svc.coupledAppImages ?? []).filter((c) => imageRepoOf(c.image) === coupledRepo);
    if (hits.length !== 1) {
      console.error(
        `FAIL-CLOSED: expected exactly one coupled app image '${coupledRepo}' on '${pinService}', found ${hits.length}.`,
      );
      process.exit(3);
    }
    image = hits[0].image;
  } else {
    image = svc.baselinePin.image;
  }
  if (!/@sha256:[0-9a-f]{64}$/.test(image)) {
    console.error(
      `FAIL-CLOSED: matrix pin for '${pinService}'${coupledRepo ? ` (${coupledRepo})` : ""} is not digest-bound: ${image}. A derived fixture default must pin bytes.`,
    );
    process.exit(3);
  }
  if (!tagOnly) {
    process.stdout.write(image);
    process.exit(0);
  }
  // --tag projects `repo:tag@digest` down to `tag@digest`. The tag separator is
  // the first colon AFTER the last slash — a colon before it belongs to a
  // registry host:port. A digest-only ref (no tag) has nothing to project and is
  // a fail-closed refusal rather than a malformed default.
  const noDigest = image.split("@")[0];
  const tagColon = noDigest.indexOf(":", noDigest.lastIndexOf("/") + 1);
  if (tagColon === -1) {
    console.error(
      `FAIL-CLOSED: matrix pin for '${pinService}' carries no tag to project with --tag: ${image}.`,
    );
    process.exit(3);
  }
  process.stdout.write(image.slice(tagColon + 1));
  process.exit(0);
}

if (positional.length !== 3) usage(`expected <serviceId> <from> <to>, got ${positional.length} argument(s)`);
const [serviceId, from, to] = positional;

const svc = getService(matrix, serviceId);
const verdict = resolveTransition(matrix, serviceId, from, to);
const out = {
  serviceId,
  from,
  to,
  ...verdict,
  service: svc
    ? {
        family: svc.family,
        composeService: svc.composeService,
        volume: svc.volume,
        stateClass: svc.stateClass,
        imageRepo: imageRepoOf(svc.baselinePin.image),
      }
    : null,
};
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
process.exit(verdict.supported ? 0 : 3);
