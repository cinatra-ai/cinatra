/**
 * The local `memory` CLI: init / add / list / recall / check.
 *
 * A thin argv layer over the library — pure filesystem, no network, no LLM.
 * Exit codes: 0 success, 1 operational failure (including conformance
 * errors from `check`), 2 usage error.
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";

import {
  findMemoryBundleRoot,
  initMemoryBundle,
  loadMemoryBundle,
  loadMemoryBundleConfig,
} from "./bundle.ts";
import { checkMemoryTree } from "./check.ts";
import { recallMemoryConcepts } from "./recall.ts";
import { MemoryError } from "./types.ts";
import { addMemoryConcept } from "./write.ts";

/** Minimal stream surface the CLI writes to (injectable for tests). */
export interface MemoryCliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

const USAGE = `Usage: memory <command> [options]

Commands:
  init    [--dir <bundle-dir>] [--name <name>]      Initialize a new bundle (default dir: ./.memory)
  add     --type <kind> [--title <t>] [--description <d>] [--tags a,b]
          [--path <rel.md>] [--body <markdown> | --body-file <file>]
          [--dir <bundle-dir>]                       Add one concept (one file per insight)
  list    [--type <kind>] [--json] [--dir <dir>]     List concepts
  recall  <query...> [--limit <n>] [--json] [--dir <dir>]
                                                     Local text search over the bundle
  check   [--json] [--dir <dir>]                     Conformance check + diagnostics

The bundle is located via --dir, else the nearest ./.memory/bundle.yaml
walking up from the current directory.`;

function resolveBundleDir(dirFlag: string | undefined, io: MemoryCliIo): string | undefined {
  if (dirFlag !== undefined) return path.resolve(dirFlag);
  const found = findMemoryBundleRoot(process.cwd());
  if (found === undefined) {
    io.err("memory: no bundle found (no .memory/bundle.yaml here or above); pass --dir or run `memory init`");
  }
  return found;
}

function runInit(args: string[], io: MemoryCliIo): number {
  const { values } = parseArgs({
    args,
    options: { dir: { type: "string" }, name: { type: "string" } },
  });
  const dir = path.resolve(values.dir ?? path.join(process.cwd(), ".memory"));
  const config = initMemoryBundle(dir, {
    ...(values.name === undefined ? {} : { name: values.name }),
  });
  io.out(`Initialized memory bundle ${config.bundleId} at ${dir}`);
  return 0;
}

function runAdd(args: string[], io: MemoryCliIo): number {
  const { values } = parseArgs({
    args,
    options: {
      dir: { type: "string" },
      type: { type: "string" },
      title: { type: "string" },
      description: { type: "string" },
      tags: { type: "string" },
      path: { type: "string" },
      body: { type: "string" },
      "body-file": { type: "string" },
    },
  });
  if (values.type === undefined || values.type.trim() === "") {
    io.err("memory add: --type is required (e.g. Convention, Correction, Command, Debugging Insight)");
    return 2;
  }
  if (values.body !== undefined && values["body-file"] !== undefined) {
    io.err("memory add: pass --body or --body-file, not both");
    return 2;
  }
  const dir = resolveBundleDir(values.dir, io);
  if (dir === undefined) return 1;
  let body = values.body;
  if (values["body-file"] !== undefined) {
    try {
      body = readFileSync(values["body-file"], "utf8");
    } catch (error) {
      throw new MemoryError(
        `cannot read --body-file ${values["body-file"]}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else if (body === undefined && !process.stdin.isTTY) {
    body = readFileSync(0, "utf8");
  }
  const tags = values.tags
    ?.split(",")
    .map((t) => t.trim())
    .filter((t) => t !== "");
  const result = addMemoryConcept(dir, {
    type: values.type,
    ...(values.title === undefined ? {} : { title: values.title }),
    ...(values.description === undefined ? {} : { description: values.description }),
    ...(tags === undefined || tags.length === 0 ? {} : { tags }),
    ...(body === undefined ? {} : { body }),
    ...(values.path === undefined ? {} : { path: values.path }),
  });
  io.out(`Added ${result.path}`);
  return 0;
}

function runList(args: string[], io: MemoryCliIo): number {
  const { values } = parseArgs({
    args,
    options: {
      dir: { type: "string" },
      type: { type: "string" },
      json: { type: "boolean" },
    },
  });
  const dir = resolveBundleDir(values.dir, io);
  if (dir === undefined) return 1;
  const bundle = loadMemoryBundle(dir);
  const concepts = bundle.concepts.filter(
    (c) => values.type === undefined || c.type === values.type,
  );
  if (values.json) {
    io.out(
      JSON.stringify(
        concepts.map((c) => ({
          id: c.id,
          path: c.path,
          type: c.type,
          title: c.title ?? null,
          description: c.description ?? null,
          tags: c.tags,
        })),
        null,
        2,
      ),
    );
    return 0;
  }
  for (const c of concepts) {
    io.out(`${c.id}\t${c.type}\t${c.title ?? ""}`);
  }
  io.out(`${concepts.length} concept(s)`);
  return 0;
}

function runRecall(args: string[], io: MemoryCliIo): number {
  const { values, positionals } = parseArgs({
    args,
    options: {
      dir: { type: "string" },
      limit: { type: "string" },
      json: { type: "boolean" },
    },
    allowPositionals: true,
  });
  const query = positionals.join(" ").trim();
  if (query === "") {
    io.err("memory recall: a query is required");
    return 2;
  }
  const limit = values.limit === undefined ? 10 : Number.parseInt(values.limit, 10);
  if (!Number.isInteger(limit) || limit <= 0) {
    io.err("memory recall: --limit must be a positive integer");
    return 2;
  }
  const dir = resolveBundleDir(values.dir, io);
  if (dir === undefined) return 1;
  const bundle = loadMemoryBundle(dir);
  const matches = recallMemoryConcepts(bundle.concepts, query, { limit });
  if (values.json) {
    io.out(
      JSON.stringify(
        matches.map((m) => ({
          id: m.concept.id,
          path: m.concept.path,
          type: m.concept.type,
          title: m.concept.title ?? null,
          score: m.score,
          snippet: m.snippet ?? null,
        })),
        null,
        2,
      ),
    );
    return 0;
  }
  if (matches.length === 0) {
    io.out("No matches.");
    return 0;
  }
  for (const m of matches) {
    io.out(`${m.concept.id}\t(score ${m.score})\t${m.concept.title ?? ""}`);
    if (m.snippet !== undefined) io.out(`  ${m.snippet}`);
  }
  return 0;
}

function runCheck(args: string[], io: MemoryCliIo): number {
  const { values } = parseArgs({
    args,
    options: { dir: { type: "string" }, json: { type: "boolean" } },
  });
  const dir = resolveBundleDir(values.dir, io);
  if (dir === undefined) return 1;
  const config = loadMemoryBundleConfig(dir);
  const result = checkMemoryTree(dir, { caps: config.caps });
  const errors = result.diagnostics.filter((d) => d.severity === "error").length;
  const warnings = result.diagnostics.length - errors;
  if (values.json) {
    io.out(
      JSON.stringify(
        {
          bundleId: config.bundleId,
          conformant: result.conformant,
          concepts: result.tree.concepts.length,
          errors,
          warnings,
          diagnostics: result.diagnostics,
        },
        null,
        2,
      ),
    );
  } else {
    for (const d of result.diagnostics) {
      io.out(`${d.severity}\t${d.code}\t${d.path}\t${d.message}`);
    }
    io.out(
      `${result.tree.concepts.length} concept(s), ${errors} error(s), ${warnings} warning(s)`,
    );
  }
  return result.conformant ? 0 : 1;
}

/** Run the CLI for an argv slice; returns the process exit code. */
export function runMemoryCli(
  argv: string[],
  io: MemoryCliIo = {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  },
): number {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "init":
        return runInit(rest, io);
      case "add":
        return runAdd(rest, io);
      case "list":
        return runList(rest, io);
      case "recall":
        return runRecall(rest, io);
      case "check":
        return runCheck(rest, io);
      case undefined:
      case "help":
      case "--help":
      case "-h":
        io.out(USAGE);
        return command === undefined ? 2 : 0;
      default:
        io.err(`memory: unknown command ${JSON.stringify(command)}`);
        io.err(USAGE);
        return 2;
    }
  } catch (error) {
    if (error instanceof MemoryError) {
      io.err(`memory: ${error.message}`);
      return 1;
    }
    if (
      error instanceof TypeError &&
      "code" in error &&
      typeof error.code === "string" &&
      error.code.startsWith("ERR_PARSE_ARGS")
    ) {
      io.err(`memory: ${error.message}`);
      return 2;
    }
    // Filesystem errors (ENOENT/EACCES/...) surface as clean one-line
    // failures, never a raw stack trace. Anything else is a real bug: rethrow.
    if (
      error instanceof Error &&
      typeof (error as NodeJS.ErrnoException).code === "string" &&
      typeof (error as NodeJS.ErrnoException).syscall === "string"
    ) {
      io.err(`memory: ${error.message}`);
      return 1;
    }
    throw error;
  }
}
