// Shared, host-neutral contract for a DYNAMICALLY-LOADED artifact-renderer
// CLIENT bundle (epic #1620 "artifact extensions own their UI", M1 Slice A —
// cinatra#1630, the main-realm dynamic loader).
//
// WHY THIS LIVES IN THE SDK LEAF: the exact-tuple identity, the externals
// allowlist, and the canonical browser-bundle signature payload are consumed by
// THREE producers that must never drift — the publish-time client-bundle
// builder (`scripts/extensions/build-client-renderer-bundle.mjs`, which INLINES
// a mirror of these constants for its standalone-execution contract, pinned by a
// parity test exactly as `build-server-entry.mjs` mirrors HOST_PROVIDED_PEERS),
// the host-side admission verifier (`src/lib/artifacts/renderer-bundle-signature.ts`),
// and the host runtime asset registry (`src/lib/artifacts/runtime-renderer-registry.ts`).
// `sdk-extensions` is a leaf package (no workspace deps of its own besides zod),
// so importing it never creates the objects↔extensions cycle.
//
// SCHEMA-ONLY / BROWSER-SAFE: this module carries the CANONICAL payload STRING
// builder + the tuple schema + the allowlist. It imports no `node:crypto` — the
// Ed25519 sign (publish) and verify (server-side admission) are host-side and
// node-only. The signed artifact is a browser-facing ESM CLIENT bundle (contrast
// `extension-signature.ts`, whose payload signs a server tarball's identity).
//
// THREAT/POSTURE NOTE (plan v3 §3.3, owner-ratified main-realm execution): a
// dynamically-loaded renderer runs in the host page with page authority. This
// contract is an ADMISSION primitive (raises the cost + traceability of getting
// malicious code admitted; binds the exact bytes to the exact tuple), NOT an
// execution boundary. It does not, and does not claim to, contain the code at
// runtime.

import { z } from "zod";

import type { ArtifactUiSlot } from "./artifact-contract";
import { ARTIFACT_UI_SLOTS } from "./artifact-contract";

// ---------------------------------------------------------------------------
// Externals allowlist — the SANCTIONED host peers that SHARE the host's ONE React.
// ---------------------------------------------------------------------------

/**
 * The design-token module the host shares in-realm as a single typed instance.
 * CSS-variable theming is already free in the shared realm (same DOM/CSS
 * scope); this typed module is additionally externalized so a renderer that
 * needs runtime token VALUES resolves the host's exact instance, not a second
 * copy.
 */
export const HOST_DESIGN_TOKEN_MODULE = "@cinatra-ai/design";

/**
 * The HOST-SHARED DESIGN-PRIMITIVES module (cinatra#3471 slice 2, epic #2926 —
 * decision 407 of 2026-09-13: "the host shares its primitives with extension
 * bundles at run time like React does"). A self-rendering connector/artifact
 * bundle leaves THIS bare specifier EXTERNAL and the host module-registry shim
 * resolves it to the host's ONE instance at run time — the exact road React and
 * the design-token module already take, so a package stops carrying byte copies
 * of `src/components/ui/*`.
 *
 * The id is HOST-NEUTRAL and follows the design registry's OWN package naming
 * (`registry.json` namespaces every item as `@cinatra-ai/<item>`, the same
 * scope the host design-token module already uses) — never a product-internal
 * path such as
 * `@/components/ui`, which is exactly the coupling decision 407 removes.
 */
export const HOST_DESIGN_PRIMITIVES_MODULE = "@cinatra-ai/design-primitives";

/**
 * The VERSIONED contract the shared primitives module serves. Semver: a MAJOR
 * bump is a breaking change to {@link HOST_DESIGN_PRIMITIVES_EXPORTS} (an export
 * removed or renamed, or a prop contract broken); a MINOR adds exports. A bundle
 * records the contract version it was BUILT against and the host refuses, at
 * load, a bundle whose MAJOR it does not serve (see
 * {@link checkDesignPrimitivesContract}).
 */
export const HOST_DESIGN_PRIMITIVES_CONTRACT_VERSION = "1.0.0";

/** The MAJOR of {@link HOST_DESIGN_PRIMITIVES_CONTRACT_VERSION} — the single
 * number the load-time fail-closed check compares on. */
export const HOST_DESIGN_PRIMITIVES_CONTRACT_MAJOR = 1;

/**
 * The FROZEN export list of the shared primitives module at contract major
 * {@link HOST_DESIGN_PRIMITIVES_CONTRACT_MAJOR} — exactly the exports of the
 * sixteen product components under `src/components/ui/` that the
 * self-rendering-extensions border floor
 * (`scripts/extensions/self-rendering-extensions-border.baseline.json`) records
 * as byte copies inside connector/artifact packages: alert, badge, button, card,
 * checkbox, dialog, field, input-group, input, label, paginated-table,
 * pagination, select, separator, table, textarea.
 *
 * The baseline ALSO lists `external-link.tsx`, `link.tsx` and `text-link.tsx`.
 * Those are NOT product primitives — they are the extensions' OWN components
 * (`vendor-extension-primitives.mjs`: "dialog.tsx / link.tsx are the
 * connector's OWN components, not registry items, so they are outside this
 * channel") and no such file exists under `src/components/ui/`, so the host
 * cannot and does not serve them.
 *
 * Adding a name here is a MINOR bump; removing or renaming one is a MAJOR.
 */
export const HOST_DESIGN_PRIMITIVES_EXPORTS = Object.freeze([
  // alert
  "Alert",
  "AlertDescription",
  "AlertTitle",
  // badge
  "Badge",
  "badgeVariants",
  // button
  "Button",
  "buttonVariants",
  // card
  "Card",
  "CardAction",
  "CardContent",
  "CardDescription",
  "CardFooter",
  "CardHeader",
  "CardTitle",
  // checkbox
  "Checkbox",
  // dialog
  "Dialog",
  "DialogClose",
  "DialogContent",
  "DialogDescription",
  "DialogFooter",
  "DialogHeader",
  "DialogOverlay",
  "DialogPortal",
  "DialogTitle",
  "DialogTrigger",
  // field
  "Field",
  "FieldContent",
  "FieldDescription",
  "FieldError",
  "FieldGroup",
  "FieldLabel",
  "FieldLegend",
  "FieldSeparator",
  "FieldSet",
  "FieldTitle",
  // input
  "Input",
  // input-group
  "InputGroup",
  "InputGroupAddon",
  "InputGroupButton",
  "InputGroupInput",
  "InputGroupText",
  "InputGroupTextarea",
  // label
  "Label",
  // paginated-table
  "PaginatedTable",
  // pagination
  "Pagination",
  "PaginationCaption",
  "PaginationContent",
  "PaginationEllipsis",
  "PaginationItem",
  "PaginationLink",
  "PaginationNext",
  "PaginationPrevious",
  // select
  "Select",
  "SelectContent",
  "SelectGroup",
  "SelectItem",
  "SelectLabel",
  "SelectScrollDownButton",
  "SelectScrollUpButton",
  "SelectSeparator",
  "SelectTrigger",
  "SelectValue",
  // separator
  "Separator",
  // table
  "Table",
  "TableBody",
  "TableCaption",
  "TableCell",
  "TableFooter",
  "TableHead",
  "TableHeader",
  "TableRow",
  // textarea
  "Textarea",
] as const);

/** One export name of the shared primitives module at the current contract
 * major — the literal union the typed contract export is built from. */
export type HostDesignPrimitiveExportName = (typeof HOST_DESIGN_PRIMITIVES_EXPORTS)[number];

/**
 * The NAMED error the host fails closed with when a bundle was built against a
 * primitives-contract MAJOR the host does not serve. Bound as the thrown
 * `Error.name` so a caller matches on the name, not on prose.
 */
export const DESIGN_PRIMITIVES_CONTRACT_MISMATCH = "DesignPrimitivesContractMajorMismatch";

/** The MAJOR of a `X.Y.Z` contract version, or null when the string is not one
 * (fail-closed: a malformed version is never treated as compatible). */
export function designPrimitivesContractMajorOf(version: string): number | null {
  if (typeof version !== "string") return null;
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (match === null) return null;
  return Number(match[1]);
}

/**
 * The LOAD-TIME contract check: does the host still serve the primitives
 * contract MAJOR a bundle was built against? Returns null when it does, else a
 * fail-loud refusal reason. Pure over its inputs so the host shim, the
 * publish-time builder mirror and a unit test share ONE rule. Fail-closed: a
 * malformed or absent `builtAgainst` refuses.
 */
export function checkDesignPrimitivesContract(input: {
  builtAgainst: string;
  hostServes?: string;
}): string | null {
  const hostServes = input.hostServes ?? HOST_DESIGN_PRIMITIVES_CONTRACT_VERSION;
  const built = designPrimitivesContractMajorOf(input.builtAgainst);
  const served = designPrimitivesContractMajorOf(hostServes);
  if (built === null) {
    return (
      `bundle declares an unreadable "${HOST_DESIGN_PRIMITIVES_MODULE}" contract version ` +
      `"${String(input.builtAgainst)}" — it must be an exact MAJOR.MINOR.PATCH version`
    );
  }
  if (served === null) {
    return (
      `the host declares an unreadable "${HOST_DESIGN_PRIMITIVES_MODULE}" contract version ` +
      `"${String(hostServes)}" — it must be an exact MAJOR.MINOR.PATCH version`
    );
  }
  if (built !== served) {
    return (
      `bundle was built against "${HOST_DESIGN_PRIMITIVES_MODULE}" contract major ${built} ` +
      `(${input.builtAgainst}) but this host serves major ${served} (${hostServes}) — ` +
      `rebuild the bundle against the host's contract`
    );
  }
  return null;
}

/**
 * The COMPLETE, closed allowlist of bare specifiers a dynamically-loaded
 * renderer client bundle may leave EXTERNAL. In the shared (main) realm a
 * second React copy is a correctness hazard ("Invalid hook call", broken
 * context/hooks — plan §2.2), so React / ReactDOM / the JSX runtimes / the
 * design-token module / the shared design-PRIMITIVES module stay external and
 * resolve to the host's SINGLE shared instances through the host
 * module-registry shim. ANY other external in the
 * publish-time esbuild metafile is REJECTED by the externals-allowlist gate
 * (`assertClientBundleExternalsAllowed`): a bundle may leave external ONLY
 * these host peers; everything else must be bundled.
 */
export const CLIENT_BUNDLE_EXTERNAL_ALLOWLIST: readonly string[] = Object.freeze([
  "react",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "react-dom",
  "react-dom/client",
  HOST_DESIGN_TOKEN_MODULE,
  HOST_DESIGN_PRIMITIVES_MODULE,
]);

/**
 * React-family specifiers whose PRESENCE (bundled OR external) in a metafile is
 * itself a signal the gate inspects: a `react`/`react-dom` INPUT that is not
 * marked external means a SECOND React copy was bundled — the exact
 * duplicate-React hazard the metafile gate exists to reject (plan §2.3).
 */
export const REACT_FAMILY_BASE_PACKAGES: readonly string[] = Object.freeze([
  "react",
  "react-dom",
]);

/** Collapse a bare specifier to its base package (`@scope/name/sub` →
 * `@scope/name`, `pkg/sub` → `pkg`). Null for relative/absolute specifiers. */
export function basePackageOf(specifier: string): string | null {
  if (typeof specifier !== "string" || specifier.length === 0) return null;
  if (specifier.startsWith(".") || specifier.startsWith("/")) return null;
  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  }
  return specifier.split("/")[0] ?? null;
}

/** True iff `specifier` is exactly one of the sanctioned external host peers. */
export function isAllowedClientBundleExternal(specifier: string): boolean {
  return CLIENT_BUNDLE_EXTERNAL_ALLOWLIST.includes(specifier);
}

/**
 * The publish-time externals gate over an esbuild metafile's external import
 * set: every external specifier MUST be a sanctioned host peer, and NO
 * React-family module may be bundled (a non-external react/react-dom INPUT).
 * Returns null when the bundle conforms, else a fail-loud refusal reason. Pure
 * over its inputs so the builder and a unit test share it.
 *
 * @param externals  the bare specifiers left external by the bundle
 * @param inputBasePackages  the base packages of the metafile's INPUT set (what
 *   got bundled) — used to detect a smuggled second React copy
 */
export function checkClientBundleExternals(input: {
  externals: readonly string[];
  inputBasePackages: readonly string[];
}): string | null {
  const unsanctioned = input.externals.filter((s) => !isAllowedClientBundleExternal(s));
  if (unsanctioned.length > 0) {
    return (
      `un-sanctioned external import(s) ${unsanctioned.map((s) => `"${s}"`).join(", ")} — a client ` +
      `renderer bundle may leave external ONLY the host peers ` +
      `${CLIENT_BUNDLE_EXTERNAL_ALLOWLIST.map((s) => `"${s}"`).join(", ")}; bundle everything else`
    );
  }
  const bundledReact = input.inputBasePackages.filter((b) =>
    REACT_FAMILY_BASE_PACKAGES.includes(b),
  );
  if (bundledReact.length > 0) {
    return (
      `bundled/transitive React copy detected (${[...new Set(bundledReact)].join(", ")} in the ` +
      `bundle INPUT set) — React/ReactDOM must stay EXTERNAL host peers so the renderer shares the ` +
      `host's single in-realm instance; a second copy breaks hooks/context`
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// The exact-tuple admitted-bundle identity (plan §2.4, G1).
// ---------------------------------------------------------------------------

/** A 128-lowercase-hex sha512 store digest (`<kind>/<slug>/<digest>`). */
export const STORE_DIGEST_RE = /^[0-9a-f]{128}$/;

/**
 * The EXACT tuple that identifies an admitted dynamically-loaded renderer
 * bundle (plan §2.4 / G1). Identity is THIS tuple — never "package installed",
 * never "present in the generated map". Both React peer ranges are enumerated
 * (`reactDomPeerRange` must live in the durable tuple, not only be signed
 * elsewhere); {@link reactPeerSetFingerprint} folds them into the single
 * unambiguous `reactPeerSet` fingerprint the registry compares on.
 */
export interface AdmittedClientBundleTuple {
  packageName: string;
  slot: ArtifactUiSlot;
  /** The content-addressed store digest of the activated bundle (128-hex sha512). */
  digest: string;
  /** The bundle entry file, RELATIVE to the digest dir (never a host FS path). */
  entry: string;
  propsApiVersion: number;
  /** The generated SDK-ABI caret range the renderer was built against. */
  sdkAbiRange: string;
  /** The host React peer range (semver range, e.g. `^19.0.0`). */
  reactPeerRange: string;
  /** The host ReactDOM peer range (semver range). */
  reactDomPeerRange: string;
  /** The design-token module ABI/version the renderer pinned. */
  tokenModuleAbi: string;
}

const clientBundleTupleSchema = z
  .object({
    packageName: z.string().min(1),
    slot: z.enum(ARTIFACT_UI_SLOTS),
    digest: z.string().regex(STORE_DIGEST_RE, "digest must be a 128-hex sha512 store digest"),
    entry: z.string().min(1),
    propsApiVersion: z.number().int().min(1),
    sdkAbiRange: z.string().min(1),
    reactPeerRange: z.string().min(1),
    reactDomPeerRange: z.string().min(1),
    tokenModuleAbi: z.string().min(1),
  })
  .strict();

export type ClientBundleTupleParseResult =
  | { ok: true; tuple: AdmittedClientBundleTuple }
  | { ok: false; diagnostic: string };

/** Validate an admitted-bundle tuple (shape + digest grammar). Never throws. */
export function parseClientBundleTuple(input: unknown): ClientBundleTupleParseResult {
  const parsed = clientBundleTupleSchema.safeParse(input);
  if (!parsed.success) {
    const at = parsed.error.issues
      .slice(0, 6)
      .map((i) => `${i.path.length ? i.path.join(".") : "<root>"} (${i.code})`)
      .join("; ");
    return { ok: false, diagnostic: `admitted client-bundle tuple is invalid: ${at}` };
  }
  return { ok: true, tuple: parsed.data as AdmittedClientBundleTuple };
}

/**
 * The separator folding the two React peer ranges into one fingerprint. NUL
 * (\u0000) is used deliberately: a valid semver range can legitimately contain
 * a SPACE (`>=1 <2`) or a PIPE (`1||2`), so those would not be injective; a NUL
 * can never appear in a range string, so the fold is a true bijection over
 * `(reactPeerRange, reactDomPeerRange)`.
 */
export const REACT_PEER_SET_SEPARATOR = "\u0000";

/**
 * The single unambiguous `reactPeerSet` fingerprint over BOTH React peer ranges,
 * enumerated in the durable/admitted tuple so registry identity
 * compares one stable token instead of two independently-mutable ranges.
 */
export function reactPeerSetFingerprint(reactPeerRange: string, reactDomPeerRange: string): string {
  return `${reactPeerRange.trim()}${REACT_PEER_SET_SEPARATOR}${reactDomPeerRange.trim()}`;
}

/** Structural identity of two admitted tuples — every field byte-equal
 * (the registry's "is this the SAME admitted bundle?" check). */
export function clientBundleTupleEquals(
  a: AdmittedClientBundleTuple,
  b: AdmittedClientBundleTuple,
): boolean {
  return (
    a.packageName === b.packageName &&
    a.slot === b.slot &&
    a.digest === b.digest &&
    a.entry === b.entry &&
    a.propsApiVersion === b.propsApiVersion &&
    a.sdkAbiRange === b.sdkAbiRange &&
    reactPeerSetFingerprint(a.reactPeerRange, a.reactDomPeerRange) ===
      reactPeerSetFingerprint(b.reactPeerRange, b.reactDomPeerRange) &&
    a.tokenModuleAbi === b.tokenModuleAbi
  );
}

// ---------------------------------------------------------------------------
// Canonical browser-bundle signature payload (extends the Ed25519 idiom of
// `extension-signature.ts`, browser-bundle-targeted — plan §5.1.1).
// ---------------------------------------------------------------------------

/** The client-bundle signature scheme id, bound into the payload so a future
 * format change is a new scheme, not a silent break. */
export const CLIENT_BUNDLE_SIGNATURE_SCHEME = "cinatra-artifact-client-bundle/v1";

/**
 * The full signed inputs: the exact admitted tuple PLUS the bundle bytes'
 * sha512 SRI integrity. Signing the tuple AND the integrity together is what
 * binds "these exact bytes" to "this exact admitted identity" (plan §2.3).
 */
export type ClientBundleSignatureFields = AdmittedClientBundleTuple & {
  /** The sha512 SRI (`sha512-...`) over the client bundle bytes. */
  integrity: string;
};

/**
 * The CANONICAL signed payload. UTF-8, LF-separated, NO trailing newline, fixed
 * field order bound to the scheme version. MUST stay byte-identical to the
 * publish-time signer (`build-client-renderer-bundle.mjs` inlines a mirror; the
 * parity test pins it). Field order is the tuple order + integrity last.
 */
export function buildClientBundleSignaturePayload(f: ClientBundleSignatureFields): string {
  return [
    CLIENT_BUNDLE_SIGNATURE_SCHEME,
    f.packageName,
    f.slot,
    f.digest,
    f.entry,
    String(f.propsApiVersion),
    f.sdkAbiRange,
    f.reactPeerRange,
    f.reactDomPeerRange,
    f.tokenModuleAbi,
    f.integrity,
  ].join("\n");
}
