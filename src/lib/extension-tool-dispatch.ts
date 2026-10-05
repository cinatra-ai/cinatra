import "server-only";

// THE PASSTHROUGH'S ONE GENERIC DISPATCH TOOL (cinatra#3249, epic #3023).
//
// The passthrough already admits generic, caller-scoped primitives: the table
// operations on the caller's own declared tables, and the artifact reads over
// the caller's own declared dependencies. What it could not do was RUN the
// calling package's own decision code — a flow language with no loop, no parse
// and no clock cannot compose one from data operations, and the passthrough
// dispatches only tools the host owns. So the host runs the caller's module,
// without naming the caller:
//
//   { tool: "extension_tool", input: { name: <a declared name>, input: { … } } }
//
// THE CALLER IS THE RUN'S, NEVER THE REQUEST'S. The package and the version are
// resolved one seam above this one, from the bound run — a request field naming
// a package would let any bridge-token holder run someone else's code. The NAME
// is resolved against THAT package's own manifest (`cinatra.tools`), so core
// keeps no table of package names; a name the caller has not declared is
// refused in the same shape the passthrough's other caller-named refusal uses.
//
// THE RUN IDENTITY STAYS IN THE ENVELOPE. A module is handed the call's own
// `input` and the ports, and nothing else: the ports are already bound to the
// run, so a module never needs the run's id, its organisation or its actor —
// and a call that tries to carry one into the module's input is refused.
//
// Nothing in this file names a package, a table, a type or a state.

import {
  EXTENSION_TOOL_MODULE_EXPORT,
  parseDeclaredTools,
  type DeclaredTool,
} from "@cinatra-ai/sdk-extensions/manifest";

import {
  normalizeReviewTargets,
  type ArtifactReviewTarget,
} from "@/lib/artifacts/artifact-review-target";
import {
  loadDeclaredToolModule,
  type ExtensionToolModuleLoaderDeps,
} from "@/lib/extension-tool-module-loader";

/** A stated refusal: never thrown past the dispatch, always a visible reason. */
export class ExtensionToolRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtensionToolRefusal";
  }
}

/**
 * The caller's own table operations, already scoped to its declared tables.
 *
 * THE RUN IS BOUND, NOT PASSED (cinatra#3249). Where the caller's declared
 * table names a run column, the host writes the bound run on an insert and a
 * module may not name that column; where a module wants THIS RUN'S rows it says
 * so with the one marker the data contract defines — `{ boundRun: true }` as
 * the `where` value on that column — and the host substitutes the run it bound.
 * So the run still never reaches a module's hands.
 *
 * AND SO IS THE SCOPE THAT RUN BELONGS TO (decided per scope): where the
 * declared table names the scope pair — the kind of scope and the id inside it,
 * in the host's own per-scope vocabulary — the host writes both on an insert,
 * a module may not name either, and a module asking for THIS SCOPE'S rows says
 * so with the second marker, `{ boundScope: true }`, on those columns. A module
 * therefore holds neither a run identity nor a scope identity: it says "mine"
 * and the host says which.
 */
export type ExtensionToolDataPort = {
  select(request: Record<string, unknown>): Promise<unknown>;
  insertIfAbsent(request: Record<string, unknown>): Promise<unknown>;
  updateWhere(request: Record<string, unknown>): Promise<unknown>;
};

/** The artifact reads, already scoped to the caller's declared dependencies. */
export type ExtensionToolArtifactsPort = {
  list(request: Record<string, unknown>): Promise<unknown>;
  contentRead(request: Record<string, unknown>): Promise<unknown>;
};

/** The review-gate filing: the artifact revisions this run's review gate pins. */
export type ExtensionToolReviewPort = {
  file(targets: unknown): void;
};

/** The clock — injected, so a module's time-boxed decisions stay testable. */
export type ExtensionToolClock = { now(): Date };

/**
 * The objects of the run's own lineage, and the records of the caller's own
 * declared artifact dependencies (cinatra#3089). Handed only to a module of an
 * AGENT package, and only while the run carries its actor context; a caller of
 * any other kind is refused.
 *
 * THE READ ADMITS BY PROVENANCE, NEVER BY TYPE. `read({ objectId })` answers
 * `{ objectId, type, data }` only for an object of the run's own organisation
 * whose run is the bound run or an ancestor of it through the parent-run link.
 * A missing object, an object outside that lineage and an object of another
 * organisation are refused in one and the same sentence, so no answer says
 * whether an object exists; an object larger than the artifact content cap is
 * refused too.
 *
 * THE SAVE ADMITS BY DECLARATION. `save({ type, data })` saves one record of a
 * type that a WINNING claim attributes to one of the caller's declared artifact
 * dependencies, a type this process holds and whose identity key gives the
 * record an identity of its own. The run is bound here as in the data port: the
 * host saves under the bound run, a module may not name the run or an external
 * id anywhere in `data`, and a top-level field whose value is the one marker
 * `{ boundRun: true }` is given the bound run's id. The save then goes through
 * the host's own objects save, whose gates refuse as they refuse every other
 * caller; it answers `{ objectId, type, isNew }`. Every read and every save is
 * audited with the calling extension.
 */
export type ExtensionToolObjectsPort = {
  read(request: Record<string, unknown>): Promise<unknown>;
  save(request: Record<string, unknown>): Promise<unknown>;
};

/** Everything a declared module is given. It reaches nothing else. */
export type ExtensionToolPorts = {
  data: ExtensionToolDataPort;
  artifacts: ExtensionToolArtifactsPort;
  review: ExtensionToolReviewPort;
  clock: ExtensionToolClock;
  objects: ExtensionToolObjectsPort;
};

/** The ONE argument a declared module's callable export takes. */
export type ExtensionToolInvocation = {
  input: Record<string, unknown>;
  ports: ExtensionToolPorts;
};

/**
 * The callable export's signature, pinned for the packs that implement it.
 *
 * A MODULE REFUSES A CALL BY NAME (cinatra#3847). A declared module refuses a
 * call by throwing an error (or any object) whose `name` is exactly
 * `EXTENSION_TOOL_CALL_REFUSAL_NAME` and whose `message` is one sentence within
 * the bounds `moduleRefusalSentenceIssue` reads: a non-empty string of at most
 * `EXTENSION_TOOL_REFUSAL_SENTENCE_MAX` characters, on one line, with no source
 * position, no path and no secret shape. The host answers it as it answers its
 * own refusals, with the text
 * "extension_tool: `<the declared name>` refused the call: <the sentence>".
 * A named refusal whose sentence breaks a bound is answered as a failure that
 * names the bound and never repeats the sentence; the sentence is not scrubbed
 * or cut into shape. Anything else a module throws is a failure, answered as a
 * server error as before. The means is the same for every module.
 */
export type ExtensionToolModule = (
  invocation: ExtensionToolInvocation,
) => unknown | Promise<unknown>;

/**
 * Envelope names that carry the run's identity. They stay in the passthrough
 * envelope: a call that puts one in the module's own input is refused rather
 * than quietly stripped, so a pack cannot come to depend on reading it.
 */
export const EXTENSION_TOOL_RUN_IDENTITY_KEYS = [
  "agent_run_id",
  "cinatra_agent_run_id",
  "cinatra_run_id",
] as const;

/** The reserved result key the filed review targets ride out under. */
export const EXTENSION_TOOL_REVIEW_TARGETS_KEY = "reviewTargets";

/** The ONE documented `name` a module's thrown refusal carries (cinatra#3847). */
export const EXTENSION_TOOL_CALL_REFUSAL_NAME = "ExtensionToolCallRefusal";

/** The longest refusal sentence of a module the host repeats, after trimming. */
export const EXTENSION_TOOL_REFUSAL_SENTENCE_MAX = 400;

/**
 * The bound a module's refusal sentence breaks, or null when it is admissible.
 * The host repeats a sentence only within these bounds and never scrubs or cuts
 * one into shape: a sentence that breaks one is not repeated at all. The secret
 * shapes are the host's own error-text bounds, written here rather than
 * imported.
 */
export function moduleRefusalSentenceIssue(sentence: unknown): string | null {
  if (typeof sentence !== "string") return "the sentence is not a string";
  const text = sentence.trim();
  if (text === "") return "the sentence is empty";
  if (text.length > EXTENSION_TOOL_REFUSAL_SENTENCE_MAX) {
    return `the sentence is longer than ${EXTENSION_TOOL_REFUSAL_SENTENCE_MAX} characters`;
  }
  if (/[\r\n\u2028\u2029]/.test(text)) return "the sentence holds a line break";
  if (/\.(?:[cm]?js|tsx?|jsx):\d+(?::\d+)?/.test(text)) {
    return "the sentence holds a source position";
  }
  if (
    /\bfile:\//i.test(text) ||
    /\b[A-Za-z]:[\\/]/.test(text) ||
    /node_modules/.test(text) ||
    /(?:^|[\s"'`(\[])(?:~|\.{1,2})?\/\S*\//.test(text)
  ) {
    return "the sentence holds a path";
  }
  if (
    /sk-ant-[A-Za-z0-9_-]+/.test(text) ||
    /sk-[A-Za-z0-9_-]{16,}/.test(text) ||
    /\b(?:AIza|ya29\.)[A-Za-z0-9_.-]+/.test(text) ||
    /(?:authorization|x-api-key|api[_-]?key|bearer)\s*[:=]\s*\S+/i.test(text) ||
    /\bbearer\s+(?=[A-Za-z0-9._~+/-]*(?:\d|[A-Za-z0-9]\.[A-Za-z0-9]))[A-Za-z0-9._~+/-]{8,}/i.test(
      text,
    ) ||
    /[A-Za-z0-9_-]{40,}/.test(text)
  ) {
    return "the sentence holds a secret shape";
  }
  return null;
}

/**
 * The host's own answer to what a module threw: its refusal for a named refusal
 * within the bounds, a failure naming the bound for one outside them, and null
 * for everything else, which the dispatch rethrows as the same value.
 */
function moduleRefusalOf(
  thrown: unknown,
  call: { packageName: string; packageVersion: string; toolName: string },
): Error | null {
  if (typeof thrown !== "object" || thrown === null) return null;
  // A getter that throws never replaces what the module threw: an unreadable
  // name is not a refusal, and an unreadable sentence breaks a bound.
  let name: unknown;
  try {
    name = (thrown as { name?: unknown }).name;
  } catch {
    return null;
  }
  if (name !== EXTENSION_TOOL_CALL_REFUSAL_NAME) return null;
  let sentence: unknown;
  try {
    sentence = (thrown as { message?: unknown }).message;
  } catch {
    sentence = undefined;
  }
  const issue = moduleRefusalSentenceIssue(sentence);
  if (issue === null) {
    return new ExtensionToolRefusal(
      `extension_tool: \`${call.toolName}\` refused the call: ${(sentence as string).trim()}`,
    );
  }
  console.warn(
    `[extension_tool] ${call.packageName}@${call.packageVersion} \`${call.toolName}\`: ` +
      `a refusal outside the bounds (${issue}); its sentence is not repeated`,
  );
  return new Error(
    `extension_tool: the module declared for \`${call.toolName}\` refused with a sentence ` +
      `outside the bounds (${issue})`,
  );
}

/** The refusal shape the passthrough's caller-named refusals already use. */
const UNDECLARED_NAME_REFUSAL =
  "extension_tool: `name` must be one of the calling extension's own declared tools";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The caller's declared tools, or a stated refusal for a declaration that does
 *  not parse — a broken declaration is the pack's, never a host failure. */
function declaredToolsOf(cinatra: Record<string, unknown>, packageName: string): DeclaredTool[] {
  try {
    return parseDeclaredTools(cinatra.tools, packageName);
  } catch (e) {
    throw new ExtensionToolRefusal(
      `extension_tool: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * Dispatch one call to the module the CALLING package declares for that name.
 * Never widens: an undeclared name, a module leaving the package's own tree, a
 * module without the callable export, or a call carrying the run's identity
 * into the module's input are each refused with a stated reason.
 */
export async function dispatchExtensionTool(input: {
  packageName: string;
  packageVersion: string;
  /** The run's own organisation — the scope the trusted install row is read in. */
  orgId: string | null;
  /** The calling package's own `cinatra` manifest block, from the bound run. */
  cinatra: Record<string, unknown>;
  /** The tool's own input envelope: `{ name, input }`. */
  request: Record<string, unknown>;
  ports: Omit<ExtensionToolPorts, "review">;
  deps?: ExtensionToolModuleLoaderDeps;
}): Promise<unknown> {
  const declared = declaredToolsOf(input.cinatra, input.packageName);
  const name = typeof input.request.name === "string" ? input.request.name.trim() : "";
  const tool = declared.find((t) => t.name === name);
  if (name === "" || !tool) {
    throw new ExtensionToolRefusal(UNDECLARED_NAME_REFUSAL);
  }

  const rawInput = input.request.input;
  if (rawInput !== undefined && rawInput !== null && !isPlainObject(rawInput)) {
    throw new ExtensionToolRefusal("extension_tool: `input` must be an object");
  }
  const moduleInput: Record<string, unknown> = isPlainObject(rawInput) ? { ...rawInput } : {};
  for (const key of EXTENSION_TOOL_RUN_IDENTITY_KEYS) {
    if (key in moduleInput) {
      throw new ExtensionToolRefusal(
        `extension_tool: the run's identity stays in the passthrough envelope — \`input\` must ` +
          `not carry \`${key}\``,
      );
    }
  }

  const namespace = await loadDeclaredToolModule(
    {
      packageName: input.packageName,
      packageVersion: input.packageVersion,
      orgId: input.orgId,
      toolName: tool.name,
      modulePath: tool.module,
    },
    input.deps ?? {},
  );
  const callable = isPlainObject(namespace) ? namespace[EXTENSION_TOOL_MODULE_EXPORT] : undefined;
  if (typeof callable !== "function") {
    throw new ExtensionToolRefusal(
      `extension_tool: the module declared for \`${tool.name}\` exports no callable ` +
        `\`${EXTENSION_TOOL_MODULE_EXPORT}\``,
    );
  }

  // THE FILING IS VALIDATED BY THE HOST'S OWN TARGET PARSER, so a malformed set
  // is refused here rather than reaching a review surface as a silent drop.
  let filed: ArtifactReviewTarget[] = [];
  const review: ExtensionToolReviewPort = {
    file(targets: unknown) {
      const normalized = normalizeReviewTargets(targets);
      if (!normalized.ok) {
        throw new ExtensionToolRefusal(`extension_tool: ${normalized.error}`);
      }
      filed = normalized.targets;
    },
  };

  // A MODULE'S NAMED REFUSAL becomes the host's own refusal; every other value
  // it throws — a failure, or a host refusal raised by a port — is rethrown as
  // the same value (cinatra#3847).
  let result: unknown;
  try {
    result = await (callable as ExtensionToolModule)({
      input: moduleInput,
      ports: { ...input.ports, review },
    });
  } catch (e) {
    throw (
      moduleRefusalOf(e, {
        packageName: input.packageName,
        packageVersion: input.packageVersion,
        toolName: tool.name,
      }) ?? e
    );
  }
  if (filed.length === 0) return result;
  if (!isPlainObject(result)) {
    throw new ExtensionToolRefusal(
      "extension_tool: a tool that files review targets must return an object for them to ride out on",
    );
  }
  return { ...result, [EXTENSION_TOOL_REVIEW_TARGETS_KEY]: filed };
}
