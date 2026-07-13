#!/usr/bin/env node
// ---------------------------------------------------------------------------
// File-backed transactional version ledger for the guarded upgrade frame
// (upgrade-paths epic cinatra#1419, non-Postgres families cinatra#1421).
//
// This is the HARNESS-DRIVABLE default behind scripts/upgrade/lib.sh's ledger
// seam (UPGRADE_LEDGER_FILE). It mirrors the journal semantics of the REAL
// deployed-version ledger that lives with the instance state in cinatra-cli
// (src/version-ledger.mjs, cinatra-cli#128) — begin opens a `pending` journal
// capturing the SOURCE entry, commit (only after post-verify) promotes the
// TARGET, rollback restores the source, and a crash mid-migration leaves the
// `pending` journal on disk as the fail-closed "interrupted migration"
// evidence. On a real deployment the cinatra-cli adapter chain (extended in
// the cinatra-cli#129 chain) drives its own ledger through the
// UPGRADE_LEDGER_HOOK seam instead of this file.
//
// Invariants shared with the real ledger:
//   * every entry is bound to the volume identity { name, createdAt } — a
//     recreated same-named volume has a different createdAt, so a stale entry
//     can never describe a new volume; `begin` ENFORCES this (a source entry
//     whose recorded identity does not match the live volume refuses);
//   * a malformed ledger file is NEVER silently reset (refuse, exit 6);
//   * begin refuses while a pending journal exists (one migration at a time;
//     an interrupted one must be resolved first);
//   * commit/rollback refuse without a matching pending journal, and require +
//     verify the journal's exact TARGET (image + volume name + createdAt) — a
//     commit can never promote a different migration nor a volume that was
//     destroyed+recreated mid-migration.
//
// NON-GOALS (this is the harness-drivable file ledger, not the production
// record): no cross-process lock and no fsync-durability guarantee — the REAL
// deployed-version ledger in cinatra-cli owns those semantics; the guarded
// frame drives it through the UPGRADE_LEDGER_HOOK seam.
//
// Usage:
//   node scripts/upgrade/ledger.mjs <record|begin|commit|rollback|show> \
//     --file <ledger.json> --service <matrix-service-id> \
//     [--image <ref>] [--volume-name <name>] [--volume-created-at <ts>]
//
// Exit codes: 0 ok · 2 usage · 6 refused (malformed / journal-state conflict).
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const LEDGER_VERSION = 1;

function usage(msg) {
  console.error(`ERROR: ${msg}`);
  console.error(
    "usage: ledger.mjs <record|begin|commit|rollback|show> --file <f> --service <id> [--image <ref>] [--volume-name <n>] [--volume-created-at <ts>]",
  );
  process.exit(2);
}

function refuse(msg) {
  console.error(`LEDGER REFUSED: ${msg}`);
  process.exit(6);
}

function parseArgs(argv) {
  const [op, ...rest] = argv;
  const args = { op };
  for (let i = 0; i < rest.length; i += 1) {
    const k = rest[i];
    if (!k.startsWith("--")) usage(`unexpected argument '${k}'`);
    const v = rest[i + 1];
    if (v === undefined) usage(`missing value for ${k}`);
    args[k.slice(2)] = v;
    i += 1;
  }
  return args;
}

function readLedgerFile(file) {
  if (!existsSync(file)) {
    return { version: LEDGER_VERSION, services: {}, pending: null, updatedAt: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    refuse(`ledger file '${file}' is unreadable/invalid JSON — refusing to touch it (a corrupt version record is never silently reset).`);
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    parsed.version !== LEDGER_VERSION ||
    !parsed.services ||
    typeof parsed.services !== "object" ||
    Array.isArray(parsed.services)
  ) {
    refuse(`ledger file '${file}' has an unrecognized shape — refusing to touch it.`);
  }
  return parsed;
}

function writeLedgerFile(file, ledger) {
  ledger.updatedAt = new Date().toISOString();
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`);
  renameSync(tmp, file);
}

function entryFrom(args) {
  for (const k of ["image", "volume-name", "volume-created-at"]) {
    if (!args[k]) usage(`--${k} is required for '${args.op}'`);
  }
  return {
    service: args.service,
    image: args.image,
    volume: { name: args["volume-name"], createdAt: args["volume-created-at"] },
    recordedAt: new Date().toISOString(),
  };
}

/** commit/rollback must finish the EXACT migration the journal records: the
 *  caller MUST name the target (image + full volume identity) and every part
 *  must match the pending target — including createdAt, so a volume that was
 *  destroyed+recreated MID-migration can never be committed over. */
function assertFinishesPending(pending, args, op) {
  for (const k of ["image", "volume-name", "volume-created-at"]) {
    if (!args[k]) usage(`--${k} is required for '${op}' (a journal is finished by naming its exact target)`);
  }
  if (pending.target.image !== args.image) {
    refuse(`${op} names target image '${args.image}' but the pending journal records '${pending.target.image}' — refusing to ${op} a different migration.`);
  }
  if (pending.target.volume.name !== args["volume-name"]) {
    refuse(`${op} names volume '${args["volume-name"]}' but the pending journal records '${pending.target.volume.name}' — refusing to ${op} a different migration.`);
  }
  if (pending.target.volume.createdAt !== args["volume-created-at"]) {
    refuse(`${op} sees live volume identity createdAt '${args["volume-created-at"]}' but the pending journal recorded '${pending.target.volume.createdAt}' — the volume was destroyed+recreated mid-migration (fail-closed).`);
  }
}

const args = parseArgs(process.argv.slice(2));
if (!args.op) usage("missing operation");
if (!["record", "begin", "commit", "rollback", "show"].includes(args.op)) {
  usage(`unknown operation '${args.op}'`);
}
if (!args.file) usage("--file is required");
if (args.op !== "show" && !args.service) usage("--service is required");

const ledger = readLedgerFile(args.file);

switch (args.op) {
  case "show": {
    process.stdout.write(`${JSON.stringify(ledger, null, 2)}\n`);
    break;
  }
  case "record": {
    // A plain install/upgrade record (no migration in flight).
    if (ledger.pending) {
      refuse(`a pending migration journal exists (service '${ledger.pending.service}') — resolve it before recording.`);
    }
    ledger.services[args.service] = entryFrom(args);
    writeLedgerFile(args.file, ledger);
    console.log(`ledger: recorded ${args.service} @ ${args.image}`);
    break;
  }
  case "begin": {
    if (ledger.pending) {
      refuse(
        `a pending migration journal already exists (service '${ledger.pending.service}', started ${ledger.pending.startedAt}) — an interrupted migration must be resolved before a new one begins (fail-closed).`,
      );
    }
    const target = entryFrom(args);
    const source = ledger.services[args.service] ?? null;
    // Volume-identity binding: a recorded source entry that does not describe
    // the LIVE volume (renamed, or destroyed+recreated => new createdAt) is a
    // fail-closed finding — its data-format claim is about a volume that no
    // longer exists.
    if (source && (source.volume.name !== target.volume.name || source.volume.createdAt !== target.volume.createdAt)) {
      refuse(
        `the recorded ${args.service} entry is bound to volume { ${source.volume.name}, ${source.volume.createdAt} } but the live volume is { ${target.volume.name}, ${target.volume.createdAt} } — identity mismatch (fail-closed; the recorded version describes a volume that no longer exists).`,
      );
    }
    ledger.pending = {
      service: args.service,
      source,
      target,
      startedAt: new Date().toISOString(),
    };
    writeLedgerFile(args.file, ledger);
    console.log(`ledger: pending journal opened for ${args.service} -> ${args.image}`);
    break;
  }
  case "commit": {
    if (!ledger.pending || ledger.pending.service !== args.service) {
      refuse(`no pending migration journal for service '${args.service}' — commit is only legal inside a begun migration.`);
    }
    assertFinishesPending(ledger.pending, args, "commit");
    ledger.services[args.service] = ledger.pending.target;
    ledger.pending = null;
    writeLedgerFile(args.file, ledger);
    console.log(`ledger: committed ${args.service} target entry`);
    break;
  }
  case "rollback": {
    if (!ledger.pending || ledger.pending.service !== args.service) {
      refuse(`no pending migration journal for service '${args.service}' — nothing to roll back.`);
    }
    assertFinishesPending(ledger.pending, args, "rollback");
    if (ledger.pending.source) {
      ledger.services[args.service] = ledger.pending.source;
    } else {
      delete ledger.services[args.service];
    }
    ledger.pending = null;
    writeLedgerFile(args.file, ledger);
    console.log(`ledger: rolled back to the source entry for ${args.service}`);
    break;
  }
  default:
    usage(`unknown operation '${args.op}'`);
}
