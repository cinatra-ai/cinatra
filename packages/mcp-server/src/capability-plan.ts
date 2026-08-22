// ---------------------------------------------------------------------------
// REQUEST-SCOPED CAPABILITY PLAN (cinatra#2817 slice 1).
//
// THE PROBLEM THIS SOLVES. Before this module the runtime server decided
// admission from a NAME and nothing else, and the chat catalog answered the
// same question by reading a static list. Two surfaces, two inputs, and no
// structural reason they had to agree. Version- and declaration-bound admission
// (slice 2) cannot be built on a name: it needs the OWNING PACKAGE, the EXACT
// RESOLVED VERSION and the DECLARATION that the host actually reviewed, for the
// registration that is actually about to serve the call.
//
// SO: one request-scoped PLAN, produced BY the registration pass, and the
// server registers FROM it. Every registration that reaches the choke point
// becomes one `PlannedPrimitive` — normalized name, declared delegated-chat
// class, owning package, exact resolved package version, capability key,
// dispatch target — recorded IN REGISTRATION ORDER. The choke point then makes
// its decision about that planned entry, and the SDK registration is driven
// from the same entry. The outcome (registered / refused, and why) is recorded
// alongside, so `plan.servable` is by construction the set that actually
// registered, never a second replay's guess at it.
//
// WHAT "ONE SOURCE" MEANS HERE, precisely. The plan is a BY-PRODUCT of the one
// pass, not a second pass. `CapabilityPlanRecorder.record()` is called from
// inside `policedRegisterTool` before the decision, and
// `markRegistered`/`markRefused` from the two exits of that same call. Running
// the registration pass a second time against a recording sink would produce a
// plan that could disagree with the server for any caller-dependent
// registration (the S8 discovery union registers a caller-dependent tool set) —
// which is exactly the disagreement class this seam exists to end.
//
// DEPENDENCY-FREE, like the policy module it sits beside: imported by the
// runtime server, by app-layer wiring and by tests, so it must not reach for a
// DB or a Next dep.
// ---------------------------------------------------------------------------

import {
  normalizeDelegatedChatToolClass,
  readDeclaredDelegatedChatClass,
  type DelegatedChatToolClass,
} from "./delegated-chat-tool-policy";
import { hostDeclaredDelegatedChatClass } from "./host-primitive-declarations";
import {
  HOST_PRIMITIVE_OWNER_PACKAGE,
  HOST_PRIMITIVE_RELEASE_VERSION,
} from "./host-primitive-identity";

export { HOST_PRIMITIVE_OWNER_PACKAGE, HOST_PRIMITIVE_RELEASE_VERSION };

/**
 * The registration-config key the host uses to stamp a primitive's PROVENANCE
 * onto the registration that carries it.
 *
 * HOST-OWNED, never author-supplied in any meaningful sense. The two paths that
 * reach `registerTool` with a non-host owner both go through host code that
 * stamps this: the extension replay in `@/lib/mcp-server` (which knows the
 * resolved package + version from the discovery plan) and the self-primitive
 * capture that mirrors it. A connector CAN write this key onto its own config —
 * and that is exactly why the stamped values are never trusted as authorization
 * on their own: they are the LOOKUP KEY into host-owned admission state
 * (slice 2), and a self-asserted owner/version simply fails to match any
 * reviewed record, which denies.
 */
export const PRIMITIVE_PROVENANCE_KEY = "cinatraPrimitive";

/**
 * WHERE a planned primitive's call actually goes. Slice 3's evaluator resolves
 * the caller's ACTUAL default/retained version from this, so a same-name
 * admission belonging to another owner or another version cannot authorize the
 * call that is really about to run.
 */
export type PrimitiveDispatchTarget = {
  /**
   * `host` — a core/bundled module registration (platform module or
   * manifest-discovered connector module).
   * `extension-default` — the DEFAULT version of an installed extension's tool.
   * `extension-versioned` — a RETAINED, version-pinned tool served only to a
   * caller whose edge pins that exact version.
   */
  readonly kind: "host" | "extension-default" | "extension-versioned";
  readonly packageName: string;
  readonly version: string;
  /** The primitive name the dispatch resolves against (normalized). */
  readonly name: string;
};

/** Why a registration could not be given a trustworthy identity. */
export type PrimitiveIdentityFailure =
  /** The provenance stamp is present but unreadable (throwing getter / Proxy). */
  | "provenance_unreadable"
  /** The provenance stamp is present but structurally invalid. */
  | "provenance_malformed"
  /**
   * The provenance stamp names the HOST package as its owner (cinatra#2817
   * review round). Only a STAMP-LESS registration is host-owned; a stamped one
   * that claims `@cinatra-ai/host` is claiming an identity the host reserves
   * for itself, so the plan refuses it outright instead of relying on the
   * release-version and collision-skip rules to make it unreachable.
   */
  | "host_owner_claimed";

/**
 * One planned primitive: everything an admission decision needs about ONE
 * registration, resolved once, at the moment the registration happened.
 */
export type PlannedPrimitive = {
  /** Lower-cased name — the form every policy and admission lookup keys on. */
  readonly name: string;
  /** The name exactly as registered, so the SDK registration is byte-faithful. */
  readonly registeredName: string;
  /** 0-based position in REGISTRATION ORDER. */
  readonly order: number;
  /**
   * The delegated-chat class this registration DECLARED, or `undefined` for a
   * registration that declared nothing. Read with the same total reader the
   * declaration choke point uses, so a hostile accessor lands on `"none"` here
   * exactly as it does there.
   */
  readonly declaredClass: DelegatedChatToolClass | undefined;
  /**
   * True when the registration declared something the host could NOT read as a
   * class (an unknown value, a wrong type, a throwing accessor).
   *
   * `declaredClass` already normalizes all of those to `"none"` — fail-closed
   * in the narrowing direction — so this changes no decision. It exists so the
   * REFUSAL can say "malformed declaration" instead of "declines chat", which
   * are the same outcome and completely different bugs to an author staring at
   * a primitive that will not appear.
   */
  readonly declarationMalformed: boolean;
  /** The package that owns the primitive. `null` when identity failed. */
  readonly ownerPackage: string | null;
  /** The EXACT resolved package version. `null` when identity failed. */
  readonly resolvedVersion: string | null;
  /** The capability whose availability gates this primitive, if any. */
  readonly capabilityKey: string | null;
  /** Where the call goes. `null` when identity failed. */
  readonly dispatchTarget: PrimitiveDispatchTarget | null;
  /**
   * Set when the identity could not be resolved. An entry carrying this can
   * never be admitted — slice 3's evaluator denies on it authoritatively rather
   * than falling back to a host identity, which would let an unreadable stamp
   * inherit the host's admissions.
   */
  readonly identityFailure: PrimitiveIdentityFailure | null;
  /** True for a host built-in the runtime server registers itself. */
  readonly reserved: boolean;
};

/** What the choke point did with one planned entry. */
export type PrimitiveRegistrationOutcome = {
  readonly planned: PlannedPrimitive;
  /** True iff `registerTool` accepted it into the live server. */
  readonly registered: boolean;
  /** Machine-readable refusal label; absent when registered. */
  readonly reason?: string;
};

/** The finished plan for ONE request-scoped registration pass. */
export type CapabilityPlan = {
  /** Every planned primitive, in REGISTRATION ORDER. */
  readonly entries: readonly PlannedPrimitive[];
  /** One outcome per entry, same order. */
  readonly outcomes: readonly PrimitiveRegistrationOutcome[];
  /** Exactly the entries that ACTUALLY registered — the servable subset. */
  readonly servable: readonly PlannedPrimitive[];
};

/** The raw provenance stamp shape. */
export type PrimitiveProvenance = {
  readonly ownerPackage: string;
  readonly resolvedVersion: string;
  readonly capabilityKey?: string | null;
  readonly dispatchTarget?: PrimitiveDispatchTarget;
};

export type PrimitiveProvenanceRead =
  /** No stamp at all — a core/bundled host registration. */
  | { readonly kind: "absent" }
  | { readonly kind: "resolved"; readonly provenance: PrimitiveProvenance }
  | { readonly kind: "failed"; readonly failure: PrimitiveIdentityFailure };

const DISPATCH_KINDS: ReadonlySet<string> = new Set([
  "host",
  "extension-default",
  "extension-versioned",
]);

function readGuarded(source: object, key: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: (source as Record<string, unknown>)[key] };
  } catch {
    return { ok: false };
  }
}

/**
 * Is the property PRESENT on the config at all?
 *
 * Distinguishing presence from an `undefined` value is load-bearing, not
 * pedantry: an ABSENT stamp means "core/bundled" and inherits the HOST identity
 * (and, from slice 2, the host's admission records), whereas a PRESENT stamp
 * that is `null`/`undefined`/a scalar is a broken one and must deny. Reading
 * the value alone cannot tell those apart. Guarded, because `in` runs a Proxy's
 * `has` trap and `hasOwnProperty` can be shadowed.
 */
function isPropertyPresent(source: object, key: string): boolean | "unreadable" {
  try {
    return Object.prototype.hasOwnProperty.call(source, key) || key in source;
  } catch {
    return "unreadable";
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Read the provenance stamp off a registration config.
 *
 * TOTAL, and fail-closed in the same direction as
 * `readDeclaredDelegatedChatClass`: a config is an arbitrary object supplied by
 * a connector, so every property read is guarded. An escaping throw here would
 * propagate out of the per-request capability build and take the whole request
 * down rather than refuse one name.
 *
 * THE THREE OUTCOMES ARE DISTINCT ON PURPOSE:
 *  - `absent`   nothing stamped → a core/bundled host registration. The caller
 *               supplies the host identity. This is the ONLY case that inherits
 *               an identity it did not state.
 *  - `resolved` a well-formed stamp → that exact owner/version is the identity.
 *  - `failed`   a stamp that is PRESENT and unreadable or structurally invalid.
 *               NEVER re-read as `absent`: doing so would let a broken (or
 *               hostile) stamp inherit the HOST's identity and, with it, the
 *               host's admission records. It denies instead.
 */
export function readPrimitiveProvenance(config: unknown): PrimitiveProvenanceRead {
  if (typeof config !== "object" || config === null) return { kind: "absent" };
  const present = isPropertyPresent(config, PRIMITIVE_PROVENANCE_KEY);
  if (present === "unreadable") return { kind: "failed", failure: "provenance_unreadable" };
  if (!present) return { kind: "absent" };
  const raw = readGuarded(config, PRIMITIVE_PROVENANCE_KEY);
  if (!raw.ok) return { kind: "failed", failure: "provenance_unreadable" };
  const value = raw.value;
  // PRESENT but not an object — including an explicit `null` or `undefined`.
  // Never re-read as absent: that would hand a broken stamp the host identity.
  if (typeof value !== "object" || value === null) {
    return { kind: "failed", failure: "provenance_malformed" };
  }

  const owner = readGuarded(value, "ownerPackage");
  const version = readGuarded(value, "resolvedVersion");
  const capability = readGuarded(value, "capabilityKey");
  const target = readGuarded(value, "dispatchTarget");
  if (!owner.ok || !version.ok || !capability.ok || !target.ok) {
    return { kind: "failed", failure: "provenance_unreadable" };
  }
  if (!nonEmptyString(owner.value) || !nonEmptyString(version.value)) {
    return { kind: "failed", failure: "provenance_malformed" };
  }
  if (capability.value !== undefined && capability.value !== null && typeof capability.value !== "string") {
    return { kind: "failed", failure: "provenance_malformed" };
  }

  let dispatchTarget: PrimitiveDispatchTarget | undefined;
  if (target.value !== undefined && target.value !== null) {
    if (typeof target.value !== "object") {
      return { kind: "failed", failure: "provenance_malformed" };
    }
    const kind = readGuarded(target.value, "kind");
    const pkg = readGuarded(target.value, "packageName");
    const ver = readGuarded(target.value, "version");
    const nm = readGuarded(target.value, "name");
    if (!kind.ok || !pkg.ok || !ver.ok || !nm.ok) {
      return { kind: "failed", failure: "provenance_unreadable" };
    }
    if (
      typeof kind.value !== "string" ||
      !DISPATCH_KINDS.has(kind.value) ||
      !nonEmptyString(pkg.value) ||
      !nonEmptyString(ver.value) ||
      !nonEmptyString(nm.value)
    ) {
      return { kind: "failed", failure: "provenance_malformed" };
    }
    dispatchTarget = {
      kind: kind.value as PrimitiveDispatchTarget["kind"],
      packageName: pkg.value,
      version: ver.value,
      name: nm.value.toLowerCase(),
    };
  }

  return {
    kind: "resolved",
    provenance: {
      ownerPackage: owner.value,
      resolvedVersion: version.value,
      capabilityKey: typeof capability.value === "string" ? capability.value : null,
      ...(dispatchTarget ? { dispatchTarget } : {}),
    },
  };
}



/**
 * Did the registration declare a value the host could not read as a class?
 *
 * TOTAL and guarded, like every other read of a connector-supplied config. A
 * present value that is not one of the four classes — including one whose
 * accessor throws — is malformed. An ABSENT declaration is not malformed; it is
 * simply undeclared, which is a different refusal with a different fix.
 */
function readDeclarationIsMalformed(config: unknown): boolean {
  if (typeof config !== "object" || config === null) return false;
  let raw: unknown;
  try {
    raw = (config as { delegatedChat?: unknown }).delegatedChat;
  } catch {
    return true;
  }
  if (raw === undefined || raw === null) return false;
  return normalizeDelegatedChatToolClass(raw) === "none" && raw !== "none";
}

/** The host identity a stamp-less (core/bundled) registration inherits. */
export type HostPrimitiveIdentity = {
  readonly packageName: string;
  /** The RELEASE version core/bundled primitives are admitted against. */
  readonly version: string;
};

export type PlanPrimitiveInput = {
  readonly name: string;
  readonly config: unknown;
  readonly order: number;
  readonly host: HostPrimitiveIdentity;
  readonly reserved?: boolean;
  /**
   * Resolves the capability key that gates a primitive, when the stamp does not
   * name one. Injected so this module stays free of the connector catalog.
   */
  readonly resolveCapabilityKey?: (name: string) => string | null | undefined;
};

/**
 * Turn one registration into one planned primitive. PURE — no I/O, no policy
 * decision. The decision is slice 3's evaluator, applied to what this returns.
 */
export function planPrimitiveRegistration(input: PlanPrimitiveInput): PlannedPrimitive {
  const normalized = input.name.toLowerCase();
  const registrationDeclaredClass = readDeclaredDelegatedChatClass(input.config);
  const declarationMalformed = readDeclarationIsMalformed(input.config);
  const provenance = readPrimitiveProvenance(input.config);

  if (provenance.kind === "failed") {
    return {
      name: normalized,
      registeredName: input.name,
      order: input.order,
      declaredClass: registrationDeclaredClass,
      declarationMalformed,
      ownerPackage: null,
      resolvedVersion: null,
      capabilityKey: null,
      dispatchTarget: null,
      identityFailure: provenance.failure,
      reserved: input.reserved === true,
    };
  }

  // THE HOST OWNER IS NOT CLAIMABLE (cinatra#2817 review round). A stamped
  // registration reaching this line came through the extension registration
  // path, and the stamp's owner is the INSTALLED package's own name. The host
  // declaration table below is gated on that owner, and the migrated core
  // records are keyed on it, so a package that named itself `@cinatra-ai/host`
  // would be reaching for a host identity. It is not exploitable today (it
  // would also have to resolve to HOST_PRIMITIVE_RELEASE_VERSION, and core
  // names are collision-skipped before the replay), but "not exploitable
  // today" is an accident of two other rules. Refuse it structurally instead.
  if (
    provenance.kind === "resolved" &&
    provenance.provenance.ownerPackage === HOST_PRIMITIVE_OWNER_PACKAGE
  ) {
    return {
      name: normalized,
      registeredName: input.name,
      order: input.order,
      declaredClass: registrationDeclaredClass,
      declarationMalformed,
      ownerPackage: null,
      resolvedVersion: null,
      capabilityKey: null,
      dispatchTarget: null,
      identityFailure: "host_owner_claimed",
      reserved: input.reserved === true,
    };
  }

  const ownerPackage =
    provenance.kind === "resolved" ? provenance.provenance.ownerPackage : input.host.packageName;
  const resolvedVersion =
    provenance.kind === "resolved" ? provenance.provenance.resolvedVersion : input.host.version;
  const stampedCapability =
    provenance.kind === "resolved" ? provenance.provenance.capabilityKey ?? null : null;
  const capabilityKey =
    stampedCapability ?? input.resolveCapabilityKey?.(normalized) ?? null;
  // THE DECLARATION IN FORCE. A registration that declares wins, in BOTH
  // directions — declaring `none` withdraws a primitive the host would have
  // declared for. A registration that declares NOTHING inherits the host's own
  // declaration, and ONLY when the host owns it.
  //
  // WHY THAT IS NOT THE DELETED INTERIM SHIM. The shim supplied a synthesized
  // class for any name a NAME ALLOWLIST admitted, downstream of the admission
  // decision. This is the opposite direction: core and bundled primitives have
  // no package of their own to declare in, so the host declares FOR them, in
  // one reviewable table, and that declaration is what gets digested and
  // reviewed like any other. It is gated on the OWNER, so an extension can
  // never reach it: an extension's registration is stamped by host code with
  // its own package name, and a stamp it wrote itself is either rejected as
  // malformed or names a package with no core records.
  const declaredClass =
    registrationDeclaredClass ??
    (ownerPackage === HOST_PRIMITIVE_OWNER_PACKAGE
      ? hostDeclaredDelegatedChatClass(normalized)
      : undefined);

  const dispatchTarget: PrimitiveDispatchTarget =
    (provenance.kind === "resolved" ? provenance.provenance.dispatchTarget : undefined) ?? {
      kind: "host",
      packageName: ownerPackage,
      version: resolvedVersion,
      name: normalized,
    };

  return {
    name: normalized,
    registeredName: input.name,
    order: input.order,
    declaredClass,
    declarationMalformed,
    ownerPackage,
    resolvedVersion,
    capabilityKey,
    dispatchTarget,
    identityFailure: null,
    reserved: input.reserved === true,
  };
}

/**
 * Records the plan AS the registration pass runs.
 *
 * Order is the recording order, which IS the registration order — the recorder
 * is driven from inside the one choke point every registration passes through.
 */
export class CapabilityPlanRecorder {
  private readonly entries: PlannedPrimitive[] = [];
  private readonly outcomes: PrimitiveRegistrationOutcome[] = [];
  private readonly host: HostPrimitiveIdentity;
  private readonly resolveCapabilityKey?: (name: string) => string | null | undefined;

  constructor(input: {
    host: HostPrimitiveIdentity;
    resolveCapabilityKey?: (name: string) => string | null | undefined;
  }) {
    this.host = input.host;
    this.resolveCapabilityKey = input.resolveCapabilityKey;
  }

  /** Plan one registration. Call ONCE per `registerTool` call, before deciding. */
  record(name: string, config: unknown, options?: { reserved?: boolean }): PlannedPrimitive {
    const planned = planPrimitiveRegistration({
      name,
      config,
      order: this.entries.length,
      host: this.host,
      reserved: options?.reserved === true,
      resolveCapabilityKey: this.resolveCapabilityKey,
    });
    this.entries.push(planned);
    return planned;
  }

  /** Record that `registerTool` accepted the entry into the live server. */
  markRegistered(planned: PlannedPrimitive): void {
    this.outcomes.push({ planned, registered: true });
  }

  /** Record that the entry was refused, and why. */
  markRefused(planned: PlannedPrimitive, reason: string): void {
    this.outcomes.push({ planned, registered: false, reason });
  }

  /** The finished, frozen plan. */
  plan(): CapabilityPlan {
    const outcomes = [...this.outcomes];
    return Object.freeze({
      entries: Object.freeze([...this.entries]),
      outcomes: Object.freeze(outcomes),
      servable: Object.freeze(outcomes.filter((o) => o.registered).map((o) => o.planned)),
    });
  }
}

/**
 * The primitive names a plan's servable entries were REGISTERED UNDER, sorted.
 *
 * `registeredName`, deliberately, NOT the normalized `name`. The registered
 * name is what the SDK holds, what `tools/list` advertises and what
 * `tools/call` resolves — so it is the only projection that can be compared
 * against the live server without lying. Projecting the normalized name instead
 * would collapse two case-distinct registrations into one entry and report a
 * catalog name the wire does not serve.
 */
export function plannedServableNames(plan: CapabilityPlan): string[] {
  return [...plan.servable.map((entry) => entry.registeredName)].sort();
}

/**
 * The NORMALIZED names of a plan's servable entries, deduped and sorted — the
 * form every policy and admission lookup keys on. Use this for a set-membership
 * question about policy, never for a claim about what the wire serves.
 */
export function plannedServableNormalizedNames(plan: CapabilityPlan): string[] {
  return [...new Set(plan.servable.map((entry) => entry.name))].sort();
}

/**
 * Build the registration-config provenance stamp. The ONE place host code
 * writes the key, so the reader above and every writer stay in lockstep.
 */
export function primitiveProvenanceStamp(provenance: PrimitiveProvenance): Record<string, unknown> {
  return { [PRIMITIVE_PROVENANCE_KEY]: provenance };
}
