import "server-only";

// THE OBJECTS PORT OF THE EXTENSION TOOL (cinatra#3089).
//
// A declared step module of an AGENT package is handed this port beside its
// data, artifacts, review and clock ports. It can read the objects of its own
// run's lineage and save records of the types its package depends on, and
// nothing more:
//
//   * THE CALLER is the one the run resolves to — its package, its pinned
//     version and its own manifest block — and it must be of the agent kind.
//   * THE READ admits by PROVENANCE: one object of the run's organisation whose
//     run is the bound run or an ancestor of it through the parent-run link.
//   * THE SAVE admits by DECLARATION: the same dependency admission the artifact
//     reads use, a type this process holds, and an identity the type's own key
//     gives the record. It then goes through the host's own objects save, the
//     same handler the passthrough's generic branch calls, under the run's
//     actor WITH the bound run, so the stored row and its stamped run are the
//     bound run and every gate of that save refuses as it does for any caller.
//
// Nothing in this file names a package, a table, a type or a state.

import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
import { withActorContext } from "@cinatra-ai/llm/actor-context";
import type { ArbitrableClaim } from "@cinatra-ai/objects/claims";
import { objectTypeRegistry } from "@cinatra-ai/objects/registry";

import type { ActorContext } from "@/lib/authz/actor-context";
import {
  admitsArtifactType,
  resolveArtifactDependencyAdmission,
  type ArtifactDependencyAdmission,
} from "@/lib/artifacts/extension-artifact-admission";
import { EXTENSION_ARTIFACT_CONTENT_MAX_BYTES } from "@/lib/artifacts/extension-artifact-reads";
import {
  EXTENSION_TOOL_RUN_IDENTITY_KEYS,
  ExtensionToolRefusal,
  type ExtensionToolObjectsPort,
} from "@/lib/extension-tool-dispatch";

/** The longest walk up the parent-run link a read follows. */
const MAX_ANCESTOR_HOPS = 16;

/** Keys the host sets on a saved record, and that a module may not name anywhere in `data`. */
const HOST_SET_DATA_KEYS: readonly string[] = [
  "externalId",
  "external_id",
  "cinatraAgentRunId",
  ...EXTENSION_TOOL_RUN_IDENTITY_KEYS,
];

/** The one marker that asks for the bound run: `{ boundRun: true }`. */
const BOUND_RUN_MARKER_KEY = "boundRun";

/** What the port reads of one object row. */
export type ExtensionObjectsPortRow = {
  id: string;
  type: string;
  data: unknown;
  runId: string | null;
  orgId: string | null;
};

/** What the port reads of one run row. */
export type ExtensionObjectsPortRun = {
  orgId?: string | null;
  parentRunId?: string | null;
};

/** What the port reads of one registered type. */
export type ExtensionObjectsPortType = {
  identityKey?: (data: Record<string, unknown>) => string | null;
};

type SaveHandler = (request: {
  primitiveName: string;
  input: { typeHint: string; rawData: Record<string, unknown> };
  actor: PrimitiveActorContext;
  mode: "agentic";
}) => unknown;

/** One injection point per outside read; each defaults to the shipped read. */
export type ExtensionObjectsPortDeps = {
  readClaims?: (orgId: string) => readonly ArbitrableClaim[];
  resolveType?: (typeId: string) => ExtensionObjectsPortType | null | undefined;
  readObject?: (
    id: string,
    scope: { orgId: string | null },
    actor?: ActorContext,
  ) => ExtensionObjectsPortRow | null | Promise<ExtensionObjectsPortRow | null>;
  readRun?: (id: string) => Promise<ExtensionObjectsPortRun | null>;
  collectHandlers?: () => Promise<Record<string, unknown>>;
  audit?: (event: Record<string, unknown>) => Promise<void>;
};

export type ExtensionObjectsPortInput = {
  /** The CALLER, resolved from the run — never from the request. */
  packageName: string;
  packageVersion: string | null;
  cinatra: Record<string, unknown>;
  /** The bound run. */
  run: { id: string; orgId: string; runBy: string | null };
  /** The run's own actor context, as the passthrough built it. */
  actor?: ActorContext | undefined;
};

async function defaultReadObject(
  id: string,
  scope: { orgId: string | null },
  actor?: ActorContext,
): Promise<ExtensionObjectsPortRow | null> {
  const { getObjectById } = await import("@/lib/objects-store");
  return getObjectById(id, scope, actor);
}

async function defaultReadRun(id: string): Promise<ExtensionObjectsPortRun | null> {
  const { readAgentRunById } = await import("@cinatra-ai/agents");
  return readAgentRunById(id);
}

async function defaultCollectHandlers(): Promise<Record<string, unknown>> {
  const { collectAllPrimitiveHandlers } = await import("@/lib/primitive-handlers");
  return collectAllPrimitiveHandlers();
}

async function defaultAudit(event: Record<string, unknown>): Promise<void> {
  const { logAuditEvent } = await import("@/lib/authz/audit");
  await logAuditEvent(event as Parameters<typeof logAuditEvent>[0]);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isBoundRunMarker(v: unknown): boolean {
  if (!isPlainObject(v)) return false;
  const keys = Object.keys(v);
  return (
    keys.length === 1 &&
    keys[0] === BOUND_RUN_MARKER_KEY &&
    Object.prototype.hasOwnProperty.call(v, BOUND_RUN_MARKER_KEY) &&
    v[BOUND_RUN_MARKER_KEY] === true
  );
}

/**
 * Read a module's request ONCE, as plain data, into a copy the port alone
 * holds: plain objects (of the object prototype or none) and arrays of
 * strings, numbers, booleans and null. An accessor, another prototype (a class
 * instance, a date, a map), a function (a `toJSON` among them), a symbol, a
 * bigint, a `__proto__` key and a cycle are refused, so what the port checks is
 * exactly what the save receives, and nothing in it can change or serialize
 * into something else afterwards. Whatever else fails while reading the
 * request is refused too.
 */
function toPlainData(value: unknown, call: "objects.read" | "objects.save"): unknown {
  const refuse = (what: string) =>
    new ExtensionToolRefusal(`extension_tool: ${call}: the request is no plain data — ${what}`);
  const path = new Set<object>();
  const copy = (v: unknown): unknown => {
    if (v === null || v === undefined) return v;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
    if (typeof v !== "object") throw refuse(`a value of type ${typeof v}`);
    if (path.has(v)) throw refuse("a value that contains itself");
    path.add(v);
    const proto: unknown = Object.getPrototypeOf(v);
    let out: unknown[] | Record<string, unknown>;
    if (Array.isArray(v)) {
      if (proto !== Array.prototype) throw refuse("an array of another prototype");
      const list: unknown[] = [];
      for (let i = 0; i < v.length; i++) {
        const d = Object.getOwnPropertyDescriptor(v, i);
        if (d && !("value" in d)) throw refuse("an accessor");
        list.push(copy(d?.value));
      }
      out = list;
    } else {
      if (proto !== Object.prototype && proto !== null) throw refuse("an object of another prototype");
      const record: Record<string, unknown> = {};
      for (const key of Object.keys(v)) {
        if (key === "__proto__") throw refuse("a `__proto__` key");
        const d = Object.getOwnPropertyDescriptor(v, key);
        if (!d) continue;
        if (!("value" in d)) throw refuse("an accessor");
        record[key] = copy(d.value);
      }
      out = record;
    }
    path.delete(v);
    return out;
  };
  try {
    return copy(value);
  } catch (e) {
    if (e instanceof ExtensionToolRefusal) throw e;
    throw refuse("it could not be read");
  }
}

/**
 * Refuse a host-set key or a misplaced run marker at any depth of `value`.
 * The top level is read by the caller, which alone may substitute the marker.
 */
function refuseNestedRunIdentity(value: unknown, seen: Set<object>): void {
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) refuseNestedRunIdentity(item, seen);
    return;
  }
  for (const [key, inner] of Object.entries(value)) {
    refuseDataKey(key);
    refuseNestedRunIdentity(inner, seen);
  }
}

function refuseDataKey(key: string): void {
  if (HOST_SET_DATA_KEYS.includes(key)) {
    throw new ExtensionToolRefusal(
      `extension_tool: objects.save: \`${key}\` is set by the host and may not stand anywhere in \`data\``,
    );
  }
  if (key === BOUND_RUN_MARKER_KEY) {
    throw new ExtensionToolRefusal(
      "extension_tool: objects.save: `boundRun` may stand only as the whole value of a top-level " +
        "field, exactly `{ boundRun: true }`",
    );
  }
}

/**
 * Create the objects port for one call of a declared module, bound to the run.
 * Creating it reads nothing; each call reads what it needs.
 */
export function createExtensionObjectsPort(
  input: ExtensionObjectsPortInput,
  deps: ExtensionObjectsPortDeps = {},
): ExtensionToolObjectsPort {
  const resolveType = deps.resolveType ?? ((typeId: string) => objectTypeRegistry.resolve(typeId));
  const readObject = deps.readObject ?? defaultReadObject;
  const readRun = deps.readRun ?? defaultReadRun;
  const collectHandlers = deps.collectHandlers ?? defaultCollectHandlers;
  const audit = deps.audit ?? defaultAudit;
  const run = input.run;

  function auditRow(
    operation: "objects_read" | "objects_save",
    decision: "allowed" | "denied",
    resourceId: string | undefined,
    metadata: Record<string, unknown>,
    admission?: ArtifactDependencyAdmission,
  ): Promise<void> {
    return audit({
      organizationId: run.orgId,
      actorPrincipalId: run.runBy ?? undefined,
      actorPrincipalType: "a2a",
      authSource: "agent",
      resourceType: "object",
      operation,
      runId: run.id,
      ...(resourceId ? { resourceId } : {}),
      decision,
      metadata: {
        extension: input.packageName,
        extensionVersion: input.packageVersion,
        ...(admission
          ? {
              admittedPackages: admission.admittedPackages,
              declarationDigest: admission.declarationDigest,
            }
          : {}),
        ...metadata,
      },
    }).catch(() => {});
  }

  /** The caller rule both calls share; the run's actor context, once admitted. */
  function admittedActor(call: "objects.read" | "objects.save"): ActorContext {
    if (input.cinatra.kind !== "agent") {
      throw new ExtensionToolRefusal(
        `extension_tool: ${call}: ${input.packageName} is no agent package — the objects port ` +
          `serves only an agent package's own step modules`,
      );
    }
    if (!input.actor) {
      throw new ExtensionToolRefusal(
        `extension_tool: ${call}: the run carries no actor context to read or save under`,
      );
    }
    return input.actor;
  }

  /** Is `runId` the bound run, or an ancestor of it in the run's organisation? */
  async function inLineage(runId: string | null): Promise<boolean> {
    if (!runId) return false;
    if (runId === run.id) return true;
    const bound = await readRun(run.id);
    if (!bound || bound.orgId !== run.orgId) return false;
    const seen = new Set<string>([run.id]);
    let next = bound.parentRunId ?? null;
    for (let hop = 0; hop < MAX_ANCESTOR_HOPS && next; hop++) {
      if (seen.has(next)) return false;
      seen.add(next);
      const ancestor = await readRun(next);
      if (!ancestor || ancestor.orgId !== run.orgId) return false;
      if (next === runId) return true;
      next = ancestor.parentRunId ?? null;
    }
    return false;
  }

  async function read(request: Record<string, unknown>): Promise<unknown> {
    let objectId = "";
    let actor: ActorContext;
    try {
      actor = admittedActor("objects.read");
      const plain = toPlainData(request, "objects.read");
      if (!isPlainObject(plain)) {
        throw new ExtensionToolRefusal("extension_tool: objects.read: the request must be a plain object");
      }
      objectId = typeof plain.objectId === "string" ? plain.objectId : "";
      if (objectId.trim() === "") {
        throw new ExtensionToolRefusal(
          "extension_tool: objects.read: `objectId` must be a non-empty string",
        );
      }
    } catch (e) {
      await auditRow("objects_read", "denied", objectId || undefined, {
        reason: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }

    const row = await readObject(objectId, { orgId: run.orgId }, actor);
    if (!row || row.orgId !== run.orgId || !(await inLineage(row.runId))) {
      // ONE sentence for a missing object, an object outside the lineage and an
      // object of another organisation: no answer says whether it exists.
      await auditRow("objects_read", "denied", objectId, { reason: "not-in-lineage" });
      throw new ExtensionToolRefusal(
        `extension_tool: objects.read: ${objectId} is not an object of this run or of a run it ` +
          `descends from`,
      );
    }
    const bytes = Buffer.byteLength(JSON.stringify(row.data) ?? "", "utf8");
    if (bytes > EXTENSION_ARTIFACT_CONTENT_MAX_BYTES) {
      await auditRow("objects_read", "denied", objectId, { reason: "over-cap", bytes });
      throw new ExtensionToolRefusal(
        `extension_tool: objects.read: ${objectId} is larger than the ` +
          `${EXTENSION_ARTIFACT_CONTENT_MAX_BYTES}-byte cap`,
      );
    }
    await auditRow("objects_read", "allowed", objectId, { objectType: row.type });
    return { objectId: row.id, type: row.type, data: row.data };
  }

  async function save(request: Record<string, unknown>): Promise<unknown> {
    let type = "";
    let actor: ActorContext;
    let admission: ArtifactDependencyAdmission | undefined;
    let rawData: Record<string, unknown>;
    try {
      // (a) THE ADMISSION — the same one, and the same "admitted to NOBODY"
      // rule, the artifact reads use. Resolved first, so every save's audit
      // row names it, whatever refuses the save.
      admission = resolveArtifactDependencyAdmission({
        packageName: input.packageName,
        packageVersion: input.packageVersion,
        cinatra: input.cinatra,
        orgId: run.orgId,
        ...(deps.readClaims ? { readClaims: deps.readClaims } : {}),
      });
      actor = admittedActor("objects.save");
      const plain = toPlainData(request, "objects.save");
      if (!isPlainObject(plain)) {
        throw new ExtensionToolRefusal("extension_tool: objects.save: the request must be a plain object");
      }
      type = typeof plain.type === "string" ? plain.type : "";
      if (type.trim() === "") {
        throw new ExtensionToolRefusal("extension_tool: objects.save: `type` must be a non-empty string");
      }
      const data = plain.data;
      if (!isPlainObject(data)) {
        throw new ExtensionToolRefusal("extension_tool: objects.save: `data` must be a plain object");
      }

      if (!admitsArtifactType(admission, type)) {
        throw new ExtensionToolRefusal(
          `extension_tool: objects.save: ${input.packageName} declares no artifact dependency that ` +
            `owns "${type}"`,
        );
      }

      // (b) A type this process holds — the save would otherwise classify it
      // by a model, which may name another type.
      const definition = resolveType(type);
      if (!definition) {
        throw new ExtensionToolRefusal(
          `extension_tool: objects.save: "${type}" is not a type this process holds`,
        );
      }

      // (c) and (d) THE RUN IS BOUND, NOT PASSED.
      rawData = {};
      const seen = new Set<object>([data]);
      for (const [key, value] of Object.entries(data)) {
        refuseDataKey(key);
        if (isBoundRunMarker(value)) {
          rawData[key] = run.id;
          continue;
        }
        refuseNestedRunIdentity(value, seen);
        rawData[key] = value;
      }

      // (e) THE IDENTITY, on exactly the data the save will see.
      if (typeof definition.identityKey !== "function") {
        throw new ExtensionToolRefusal(
          `extension_tool: objects.save: "${type}" declares no identity key, so a saved record ` +
            `could not be told apart from its retry`,
        );
      }
      let key: unknown;
      try {
        key = definition.identityKey({ ...rawData, cinatraAgentRunId: run.id });
      } catch {
        key = null;
      }
      if (typeof key !== "string" || key.trim() === "") {
        throw new ExtensionToolRefusal(
          `extension_tool: objects.save: the identity key of "${type}" gives this record no identity`,
        );
      }
    } catch (e) {
      await auditRow(
        "objects_save",
        "denied",
        type || undefined,
        { reason: e instanceof Error ? e.message : String(e) },
        admission,
      );
      throw e;
    }

    // (f) THE SAVE — the generic branch's own handler, under the run's actor
    // with the bound run; whatever it throws reaches the module unchanged.
    const handlers = await collectHandlers();
    const handler = handlers["objects_save"];
    if (typeof handler !== "function") {
      throw new Error("extension_tool: objects.save: the host's objects save is not registered");
    }
    const handlerActor: PrimitiveActorContext & { runId: string } = {
      actorType: actor.principalType === "HumanUser" ? "human" : "system",
      userId: actor.principalType === "HumanUser" ? actor.principalId : undefined,
      source: "a2a",
      orgId: actor.organizationId,
      platformRole: actor.platformRole,
      runId: run.id,
    };
    await auditRow("objects_save", "allowed", type, {}, admission);
    const result = await withActorContext(actor, () =>
      (handler as SaveHandler)({
        primitiveName: "objects_save",
        input: { typeHint: type, rawData },
        actor: handlerActor,
        mode: "agentic",
      }),
    );
    const saved = isPlainObject(result) ? result : {};
    return { objectId: saved.objectId, type: saved.type, isNew: saved.isNew };
  }

  return { read, save };
}
