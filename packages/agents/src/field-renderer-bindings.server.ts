import "server-only";

// Installed-package field-renderer binding collector (cinatra#151 Stage 5).
//
// SOURCE B of the two-source binding registration (Source A is the generated
// build-time map src/lib/generated/agent-bindings.ts): agent packages
// installed at RUNTIME (marketplace/registry installs) are MATERIALIZED on
// disk under `resolveAgentRuntimeMountDir()` (the projected runtime mount) with their
// package.json manifest — this module enumerates those manifests, validates
// `cinatra.fieldRenderers` with the SAME shared validator the generator uses
// (scripts/extensions/agent-binding-kinds.mjs) and returns normalized
// entries. Posture: SKIP-WARN — runtime data can never break the host
// (generation-time data is fail-closed instead).
//
// Sync on purpose: the A2UI adapter's translator resolution happens inside
// synchronous adapter construction/dispatch, and the registry merge wants a
// deterministic snapshot. The scan is a bounded readdir over
// extensions/<scope>/<name>/package.json with a short TTL cache.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  validateFieldRendererDeclarations,
  mergeFieldRendererBindings,
  comparableFieldRendererBinding,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — dependency-free .mjs data/validation module (allowJs)
} from "../../../scripts/extensions/agent-binding-kinds.mjs";
import {
  GENERATED_FIELD_RENDERER_BINDINGS,
} from "@/lib/generated/agent-bindings";
import { resolveAgentRuntimeMountDir } from "./agent-runtime-mount";
import type { FieldRendererBindingInput } from "./register-default-renderers";
import {
  DECLARED_SCREEN_PIN_KEY,
  DECLARED_SCREEN_PIN_NONE,
  DECLARED_SCREEN_SEAL_KEY,
  DECLARED_SCREEN_PIN_UNVERIFIED,
  readDeclaredScreenPin,
  stepPinAdmits,
} from "./field-renderer-registry";
import type { DeclaredHitlCard } from "./hitl-gate-submit";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore: dependency-free .mjs validation module (allowJs)
import {
  isUnsupportedKindScreen,
  validateHitlScreen,
} from "../../../scripts/extensions/agent-hitl-screen-schema.mjs";
import {
  A2UI_MID_RUN_TRANSLATOR_KINDS,
  type MidRunTranslatorResolver,
} from "@cinatra-ai/agent-ui-protocol/server";

type CollectedBinding = FieldRendererBindingInput & { declaredBy: string };

const CACHE_TTL_MS = 10_000;

/**
 * One scan of the installed agents. `complete` is false when a part of the
 * mount could not be read (cinatra#3470): the mount unreadable, or a package
 * manifest unreadable or unparsable. Such a scan does not say that an id it
 * does not name declares nothing, so every reader of an absent id answers
 * "could not be loaded", never "no screen".
 */
type InstalledScan = {
  entries: CollectedBinding[];
  refusedScreenIds: string[];
  complete: boolean;
  /**
   * The installed packages that could not be read cleanly, by the identity
   * their mount folder gives them (`@<scope>/<dir>`): a manifest unreadable,
   * torn (unparsable), naming another package than its folder, or declaring
   * its renderers in a form the validator refuses whole. `@<scope>/` stands
   * for every package of a scope that could not be listed, and `*` for every
   * package when the mount could not be listed. Such a package may be the
   * owner of a bundled id and declare another screen for it than the
   * generated binding (`bundledOwnerUnread`).
   */
  unreadPackages: string[];
};

let cache: ({ at: number } & InstalledScan) | null = null;

/** The bundled ids already warned about a foreign installed declaration. */
const warnedForeignDeclaration = new Set<string>();

/**
 * May the package mounted at `<scope>/<dir>` that names itself `packageName`
 * declare the bundled (generated) id whose binding is `generated`
 * (cinatra#3470)? Only the package that owns it: the generated binding's own
 * declarer, read from the build. The installed package's identity is the
 * mount directory the installer projected it to (`@<vendor>/<slug>` ->
 * `<mount>/<vendor>/<slug>`), and the manifest's own name must agree with it:
 * a manifest's name claim alone never makes a package the owner.
 */
function ownsBundledId(
  generated: { declaredBy: string },
  mountedAs: string,
  packageName: string,
): boolean {
  return mountedAs === generated.declaredBy && packageName === mountedAs;
}

function warnForeignDeclaration(id: string, packageName: string, mountedAs: string, owner: string): void {
  if (warnedForeignDeclaration.has(id)) return;
  warnedForeignDeclaration.add(id);
  console.warn(
    `[field-renderer-bindings] installed package ${packageName} (mounted as ${mountedAs}) declares ${id}, ` +
      `which the bundled package ${owner} owns: the declaration is refused and the generated binding wins`,
  );
}

/** Test hook — drop the TTL cache. */
export function __clearInstalledFieldRendererBindingsCache(): void {
  cache = null;
  warnedForeignDeclaration.clear();
}

/**
 * Enumerate `<agentInstallDir>/<scope>/<name>/package.json` and collect the
 * validated `cinatra.fieldRenderers` declarations. A missing mount directory
 * (no agents installed, build contexts, fresh trees) is a NORMAL state and
 * answers []. A mount or manifest that could not be read answers the
 * bindings that were read; the scan is then incomplete (`collectInstalled`).
 */
export function collectInstalledFieldRendererBindings(): CollectedBinding[] {
  return collectInstalled().entries;
}

/**
 * The ids of installed bindings that declared a HITL screen the validator
 * refused (cinatra#3470), apart from any id another installed binding still
 * registers. Such a gate is a declared screen the host cannot draw: the run
 * page holds its Continue instead of reading it as a gate with no screen.
 */
export function collectInstalledRefusedScreenIds(): string[] {
  return collectInstalled().refusedScreenIds;
}

/** Is the scan `collectInstalled` would answer now the cached one? */
function scanIsCached(): boolean {
  return cache !== null && Date.now() - cache.at < CACHE_TTL_MS;
}

/** The error code of a failed file-system call, if it carries one. */
function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Is a failed read of a path only its absence (cinatra#3470)? ENOENT: nothing
 * is there. ENOTDIR: a file stands where a directory was looked for (a stray
 * file beside the package folders). Every other error (EACCES, EIO, …) is a
 * collection error: something may be declared there that was not read.
 */
function isAbsence(err: unknown): boolean {
  const code = errorCode(err);
  return code === "ENOENT" || code === "ENOTDIR";
}

function warnUnread(what: string, err: unknown): void {
  const reason = errorCode(err) ?? (err instanceof Error ? err.message : String(err));
  console.warn(`[field-renderer-bindings] could not read ${what}: ${reason}`);
}

/**
 * The installed bindings and the refused screen ids. `fresh` scans past the
 * cache: an answer that must not miss an agent installed within the TTL
 * (cinatra#3470) asks for it.
 */
function collectInstalled(opts?: { fresh?: boolean }): InstalledScan {
  if (opts?.fresh !== true && cache && scanIsCached()) return cache;
  const all: CollectedBinding[] = [];
  const refused = new Set<string>();
  const generatedById = new Map(GENERATED_FIELD_RENDERER_BINDINGS.map((b) => [b.id, b]));
  let complete = true;
  const unread = new Set<string>();
  const scan = (): void => {
    let installDir: string;
    try {
      installDir = resolveAgentRuntimeMountDir();
    } catch (err) {
      warnUnread("the agent runtime mount", err);
      complete = false;
      unread.add("*");
      return;
    }
    // SORTED traversal — first-declarer-wins among runtime duplicates must be
    // deterministic (alphabetical), never filesystem-order dependent (the
    // converged "generated-then-alphabetical" merge order).
    let scopes: string[];
    try {
      scopes = readdirSync(installDir).sort();
    } catch (err) {
      // No mount directory: no agents are installed.
      if (errorCode(err) === "ENOENT") return;
      warnUnread("the agent runtime mount", err);
      complete = false;
      unread.add("*");
      return;
    }
    for (const scope of scopes) {
      let dirs: string[];
      try {
        dirs = readdirSync(join(installDir, scope)).sort();
      } catch (err) {
        if (isAbsence(err)) continue;
        warnUnread(`the installed scope ${scope}`, err);
        complete = false;
        unread.add(`@${scope}/`);
        continue;
      }
      for (const dir of dirs) {
        const mountedAs = `@${scope}/${dir}`;
        let text: string;
        try {
          text = readFileSync(join(installDir, scope, dir, "package.json"), "utf8");
        } catch (err) {
          if (isAbsence(err)) continue; // not a package dir
          warnUnread(`the manifest of ${scope}/${dir}`, err);
          complete = false;
          unread.add(mountedAs);
          continue;
        }
        let pkg: {
          name?: unknown;
          cinatra?: { fieldRenderers?: unknown };
        };
        try {
          pkg = JSON.parse(text);
        } catch (err) {
          warnUnread(`the manifest of ${scope}/${dir}`, err);
          complete = false;
          unread.add(mountedAs);
          continue;
        }
        const packageName = typeof pkg?.name === "string" ? pkg.name : null;
        const declared = pkg?.cinatra?.fieldRenderers;
        // A manifest that does not name the package its folder holds, or
        // that declares its renderers in a form refused whole, is not a clean
        // read of that package: if it owns a bundled id, what it declares for
        // that id is not known.
        if (packageName !== mountedAs || (declared !== undefined && !Array.isArray(declared))) {
          unread.add(mountedAs);
        }
        if (!packageName || declared === undefined) continue;
        const { entries, errors, refusedScreenIds } = validateFieldRendererDeclarations(
          packageName,
          declared,
        ) as { entries: CollectedBinding[]; errors: string[]; refusedScreenIds: string[] };
        for (const err of errors) {
          console.warn(`[field-renderer-bindings] skipped invalid declaration: ${err}`);
        }
        // A bundled id is declared at runtime only by the package that owns
        // it (`ownsBundledId`): any other package's declaration of it, or
        // refusal of its screen, is refused and never reaches the merge.
        const owned = (id: string): boolean => {
          const generated = generatedById.get(id);
          if (generated === undefined || ownsBundledId(generated, mountedAs, packageName)) return true;
          warnForeignDeclaration(id, packageName, mountedAs, generated.declaredBy);
          return false;
        };
        all.push(...entries.filter((e) => owned(e.id)));
        for (const id of refusedScreenIds) if (owned(id)) refused.add(id);
      }
    }
  };
  scan();
  const { merged, errors: mergeErrors } = mergeFieldRendererBindings(all) as {
    merged: CollectedBinding[];
    errors: string[];
  };
  for (const err of mergeErrors) {
    console.warn(`[field-renderer-bindings] conflicting declarations (first declarer wins): ${err}`);
  }
  const registered = new Set(merged.map((b) => b.id));
  cache = {
    at: Date.now(),
    entries: merged,
    refusedScreenIds: [...refused].filter((id) => !registered.has(id)).sort(),
    complete,
    unreadPackages: [...unread].sort(),
  };
  return cache;
}

/**
 * Could the package that owns a bundled id (`declaredBy`, `@<vendor>/<slug>`)
 * not be read cleanly by `scan` (cinatra#3470)? Its installed manifest may
 * then declare another screen for the id than the generated binding, so the
 * generated binding is no proof of what the id declares: every reader holds
 * the id as could not be loaded until the package reads cleanly. A bundled id
 * whose owner was read cleanly, or has no installed package at all, is not.
 */
function bundledOwnerUnread(scan: InstalledScan, declaredBy: string): boolean {
  if (scan.unreadPackages.length === 0) return false;
  const unread = new Set(scan.unreadPackages);
  if (unread.has("*") || unread.has(declaredBy)) return true;
  const slash = declaredBy.indexOf("/");
  return slash > 0 && unread.has(declaredBy.slice(0, slash + 1));
}

/** The bundled ids whose owning package `scan` could not read cleanly (`bundledOwnerUnread`). */
function bundledIdsWithUnreadOwner(scan: InstalledScan): string[] {
  return GENERATED_FIELD_RENDERER_BINDINGS.filter((b) => bundledOwnerUnread(scan, b.declaredBy))
    .map((b) => b.id)
    .sort();
}

/** What the run page's runtime bindings fetch answers (cinatra#3470). */
export type RuntimeFieldRendererBindingsPayload = {
  bindings: FieldRendererBindingInput[];
  /** Installed ids whose declared screen was refused (`collectInstalledRefusedScreenIds`). */
  refusedScreenIds: string[];
  /**
   * Bundled ids whose owning package could not be read cleanly
   * (`bundledOwnerUnread`): the binding compiled into the page may not be
   * what the id declares now, so each is held as could not be loaded.
   */
  unreadOwnerIds?: string[];
  /**
   * Present when a part of the installed agents could not be read: the
   * answer names only what was read, and an id it does not name may still
   * declare a screen (held as "could not be loaded", never as no screen).
   */
  incomplete?: true;
  /**
   * The pin (`declaredScreenPin`) of every merged binding that declares a
   * screen, generated ones included, by id. The run page draws a parked step
   * only under the declaration its own pin names. Absent from an answer
   * that read no bindings (no session): a pinned step is then held.
   */
  screenPins?: Record<string, string>;
};

/**
 * The installed bindings the client registers, and the ids of declared screens
 * the validator refused. Generated (build-time) bindings are already compiled
 * into the client registry, so the list names only installed ones: those of
 * ids the generated map does not carry, and those whose declared screen
 * supersedes a generated binding of the same id (`getMergedFieldRendererBindings`).
 * The refused ids include generated ids whose installed screen was refused.
 */
export function runtimeFieldRendererBindingsPayload(
  opts?: { fresh?: boolean },
): RuntimeFieldRendererBindingsPayload {
  const scan = collectInstalled({ fresh: opts?.fresh === true });
  const { refusedScreenIds, complete } = scan;
  const unreadOwnerIds = bundledIdsWithUnreadOwner(scan);
  const merged = getMergedFieldRendererBindings();
  const generated = new Set<unknown>(GENERATED_FIELD_RENDERER_BINDINGS);
  return {
    bindings: merged
      .filter((b) => !generated.has(b))
      .map(({ id, kind, priority, midRunHitl, a2uiTranslator, params, screen }) => ({
        id,
        kind,
        priority,
        ...(midRunHitl === true ? { midRunHitl: true } : {}),
        ...(a2uiTranslator !== undefined ? { a2uiTranslator } : {}),
        ...(params !== undefined ? { params } : {}),
        ...(screen !== undefined ? { screen } : {}),
      })),
    refusedScreenIds,
    ...(unreadOwnerIds.length > 0 ? { unreadOwnerIds } : {}),
    ...(complete ? {} : { incomplete: true as const }),
    screenPins: Object.fromEntries(
      merged
        .filter((b) => b.screen !== undefined && !unreadOwnerIds.includes(b.id))
        .map((b) => [b.id, declaredScreenPin(b)]),
    ),
  };
}

/** The JSON of a value with every object's keys in order. */
function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(sort(value)) ?? "null";
}

/**
 * THE PIN OF A BINDING'S DECLARED SCREEN (cinatra#3470): a digest of what
 * draws the screen and reads its answer (the id, the kind, the mid-run flag,
 * the params and the screen itself), or `DECLARED_SCREEN_PIN_NONE` for a
 * binding that declares none. The host writes it into a gate's schema when
 * it parks the run (`DECLARED_SCREEN_PIN_KEY`), and every reader compares it
 * with the binding installed now.
 */
export function declaredScreenPin(binding: {
  id: string;
  kind: string;
  midRunHitl?: boolean;
  params?: unknown;
  screen?: unknown;
}): string {
  if (binding.screen === undefined) return DECLARED_SCREEN_PIN_NONE;
  const declaration = canonicalJson({
    id: binding.id,
    kind: binding.kind,
    midRunHitl: binding.midRunHitl === true,
    params: binding.params ?? null,
    screen: binding.screen,
  });
  return `sha256:${createHash("sha256").update(declaration).digest("hex")}`;
}

/**
 * The pin of what `xRenderer` declares now, or null when that cannot be read
 * (a refused declaration, an id an incomplete scan does not name, a failed
 * read): those are held as unavailable on their own. `fresh` reads past the
 * bindings cache (`lookupFieldRendererBinding`).
 */
export function currentDeclaredScreenPin(
  xRenderer: string,
  opts?: { fresh?: boolean },
): string | null {
  try {
    const { binding, refused, unknown } = lookupFieldRendererBinding(xRenderer, opts);
    if (binding === undefined) return refused || unknown ? null : DECLARED_SCREEN_PIN_NONE;
    return declaredScreenPin(binding);
  } catch {
    return null;
  }
}

/**
 * Does the parked step whose gate schema is `stepSchema` still have the
 * declaration it opened under (cinatra#3470)? "matches"; "changed" when the
 * renderer installed now declares another screen, or a screen where the step
 * opened with none, or none where it opened with one; "unknown" when what is
 * declared now cannot be read. A step whose declaration could not be read when
 * it opened (`DECLARED_SCREEN_PIN_UNVERIFIED`) is "unknown" while it still
 * cannot be read and "matches" the declaration once it reads cleanly: it is
 * held, never stranded, and never answered past the declaration installed
 * when it is sent. A step is drawn, filled and submitted only on
 * "matches". The answer that is sent reads it `fresh`: a cached declaration
 * can still name a screen updated or uninstalled within the cache's seconds.
 */
export function stepDeclarationStanding(
  xRenderer: string,
  stepSchema: unknown,
  opts?: { fresh?: boolean },
): "matches" | "changed" | "unknown" {
  const current = currentDeclaredScreenPin(xRenderer, opts);
  if (current === null) return "unknown";
  return stepPinAdmits(readSealedDeclaredScreenPin(xRenderer, stepSchema), current)
    ? "matches"
    : "changed";
}

// The key of the host's pin seals: derived from the app secret under its own
// label, as the host's other signatures are (the lifecycle refs, the hold
// ref), so a seal is never valid as any other host token, or the reverse.
const DECLARED_SCREEN_SEAL_KEY_INFO = "cinatra:declared-screen-pin-seal:v1";

function declaredScreenSealKey(): Buffer | null {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) return null;
  return createHmac("sha256", secret).update(DECLARED_SCREEN_SEAL_KEY_INFO).digest();
}

/**
 * The host's seal over the pin `pin` of a step of the gate drawn by
 * `xRenderer` (cinatra#3470), or null with no app secret. Only the host can
 * make it: an agent's schema can name any pin, but never seal one. It binds
 * the renderer id, so a seal never vouches for a pin under another id.
 */
function sealDeclaredScreenPin(xRenderer: string, pin: string): string | null {
  const key = declaredScreenSealKey();
  if (key === null) return null;
  const mac = createHmac("sha256", key).update(`h1\n${xRenderer}\n${pin}`, "utf8").digest("hex");
  return `h1:${mac}`;
}

/**
 * The pin a parked step's gate schema carries, read only when the host sealed
 * it for this renderer (`DECLARED_SCREEN_SEAL_KEY`): any other pin reads as
 * no screen (`readDeclaredScreenPin`), never as the pin it names.
 */
export function readSealedDeclaredScreenPin(xRenderer: string, stepSchema: unknown): string {
  return readDeclaredScreenPin(stepSchema, (pin, seal) => {
    const expected = sealDeclaredScreenPin(xRenderer, pin);
    if (expected === null || expected.length !== seal.length) return false;
    return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(seal, "utf8"));
  });
}

/**
 * A gate schema with the pin of the screen its renderer declares now, written
 * when the host parks the run on it. A renderer that declares no screen writes
 * no pin (the schema of every gate without a screen stays as it was): the step
 * then reads as opened with no screen, and a screen declared later is never
 * drawn for it. A declaration that cannot be read is never written as no
 * screen: the pin then says the step's declaration is unverified
 * (`DECLARED_SCREEN_PIN_UNVERIFIED`), and the step is held until it reads
 * cleanly (`stepDeclarationStanding`). A pin or seal the gate's own schema
 * carries is dropped: only the host writes one, sealed with a key derived
 * from the app secret (`DECLARED_SCREEN_SEAL_KEY`), and a reader reads only a
 * pin the host sealed. The pin is read
 * FRESH past the bindings cache, as the check before an answer is sent reads
 * it: a cached declaration can be one updated since, and a step pinned to it
 * would refuse every answer to the screen installed when it opened.
 */
export function withDeclaredScreenPin(
  schema: Record<string, unknown>,
  xRenderer: string,
): Record<string, unknown> {
  const { [DECLARED_SCREEN_PIN_KEY]: _held, [DECLARED_SCREEN_SEAL_KEY]: _heldSeal, ...rest } = schema;
  void _held;
  void _heldSeal;
  const pin = currentDeclaredScreenPin(xRenderer, { fresh: true }) ?? DECLARED_SCREEN_PIN_UNVERIFIED;
  if (pin === DECLARED_SCREEN_PIN_NONE) return rest;
  const seal = sealDeclaredScreenPin(xRenderer, pin);
  if (seal === null) {
    // No app secret: no pin can be sealed, and an unsealed pin reads as no
    // screen, so the step is held as changed when its renderer declares one.
    console.warn(`[field-renderer-bindings] no app secret: the step of ${xRenderer} is parked without a sealed pin`);
    return rest;
  }
  return { ...rest, [DECLARED_SCREEN_PIN_KEY]: pin, [DECLARED_SCREEN_SEAL_KEY]: seal };
}

/**
 * The merged binding snapshot: generated build-time bindings FIRST
 * (precedence), then installed-package bindings for ids the generated map
 * does not carry. Deterministic; used by the server action, the A2UI
 * translator resolver, and kind-based ID lookups.
 *
 * AN INSTALLED DECLARED SCREEN SUPERSEDES THE GENERATED BINDING (cinatra#3470).
 * An installed binding of a generated id that declares a screen, installed by
 * the package that owns that id (the scan refuses every other package's
 * declaration of a generated id, `ownsBundledId`), is the installed truth of
 * that id's screen: it takes the generated binding's place,
 * so the run page draws it, the park pins it and the submit checks it, never
 * the generated metadata it replaced. A generated id whose installed screen the
 * validator refused is dropped: it reads as a refused screen, held, never as
 * the generated binding. An installed duplicate that declares no screen leaves
 * the generated binding in place.
 */
const warnedGeneratedDivergence = new Set<string>();

export function getMergedFieldRendererBindings(): ReadonlyArray<CollectedBinding> {
  const generatedById = new Map(
    GENERATED_FIELD_RENDERER_BINDINGS.map((b) => [b.id, b]),
  );
  const scan = collectInstalled();
  const refused = new Set(scan.refusedScreenIds);
  const runtimeOnly: CollectedBinding[] = [];
  const superseding = new Map<string, CollectedBinding>();
  for (const b of scan.entries) {
    const generated = generatedById.get(b.id);
    if (!generated) {
      runtimeOnly.push(b);
      continue;
    }
    if (b.screen !== undefined) {
      superseding.set(b.id, b);
      if (!warnedGeneratedDivergence.has(b.id)) {
        warnedGeneratedDivergence.add(b.id);
        console.warn(
          `[field-renderer-bindings] installed package ${b.declaredBy} declares a screen for ${b.id}; ` +
            `it supersedes the generated binding (declared by ${generated.declaredBy})`,
        );
      }
      continue;
    }
    // Generated precedence; a DIVERGENT runtime duplicate is named loudly
    // (once per id) so a drifted installed package is diagnosable — runtime
    // data still never breaks the host.
    if (
      comparableFieldRendererBinding(generated) !==
        comparableFieldRendererBinding(b) &&
      !warnedGeneratedDivergence.has(b.id)
    ) {
      warnedGeneratedDivergence.add(b.id);
      console.warn(
        `[field-renderer-bindings] installed package ${b.declaredBy} declares ${b.id} ` +
          `divergently from the generated binding (declared by ${generated.declaredBy}); ` +
          `the generated binding wins`,
      );
    }
  }
  return [
    ...(GENERATED_FIELD_RENDERER_BINDINGS as ReadonlyArray<CollectedBinding>)
      .filter((b) => !refused.has(b.id))
      .map((b) => superseding.get(b.id) ?? b),
    ...runtimeOnly,
  ];
}

/**
 * Whether a binding's declared screen is a "kind" layout naming a kind outside
 * the one supported-kind set (cinatra#3470) that the validator and the browser
 * registration read too. Such a screen is never drawn, whatever its source
 * (generated or installed), so it is refused here as there.
 */
export function isUndrawableDeclaredScreen(binding: { kind: string; screen?: unknown }): boolean {
  return isUnsupportedKindScreen(binding.kind, binding.screen) as boolean;
}

/**
 * Whether a gate's renderer names a declared screen the host cannot draw
 * (cinatra#3470): an installed binding declared a screen for this id, the
 * validator refused it, and no binding registers the id; or the binding that
 * registers it declares a "kind" screen of an unsupported kind. This is the
 * run page's rule (`useRuntimeFieldRendererBindings` holds such a gate), read
 * here for the conversation core and the bound-card resolver, so no host reads
 * a refused screen as a gate with no screen.
 */
export function isRefusedDeclaredScreen(xRenderer: string): boolean {
  const { binding, refused, unknown } = lookupFieldRendererBinding(xRenderer);
  if (binding) return isUndrawableDeclaredScreen(binding);
  return refused || unknown;
}

/**
 * The merged binding of exactly this id, or whether an installed declaration
 * of it was refused (cinatra#3470). A CACHED SCAN NEVER SAYS AN ID DECLARES
 * NOTHING: the scan is cached for a few seconds, and an agent installed within
 * them is missing from it. When the cached scan names the id neither way, the
 * installed agents are scanned again, and only that answer reads as none.
 * NOR DOES AN INCOMPLETE SCAN: when a part of the installed agents could not be
 * read, an id it does not name is `unknown` (could not be loaded), never none.
 * NOR DOES A GENERATED BINDING WHOSE OWNER WAS NOT READ CLEANLY: a bundled id
 * whose owning package's manifest could not be read cleanly
 * (`bundledOwnerUnread`) is `unknown` too, since that manifest may declare
 * another screen for it than the generated binding.
 * `fresh` scans the installed agents first, whatever the cache holds: the
 * check before an answer is sent reads it, since a cached binding can be one
 * updated or uninstalled since.
 */
export function lookupFieldRendererBinding(
  xRenderer: string,
  opts?: { fresh?: boolean },
): { binding: CollectedBinding | undefined; refused: boolean; unknown: boolean } {
  const read = () => {
    const binding = getMergedFieldRendererBindings().find((b) => b.id === xRenderer);
    const scan = collectInstalled();
    if (
      binding !== undefined &&
      (GENERATED_FIELD_RENDERER_BINDINGS as ReadonlyArray<unknown>).includes(binding) &&
      bundledOwnerUnread(scan, binding.declaredBy)
    ) {
      return { binding: undefined, refused: false, unknown: true };
    }
    const refused = binding === undefined && scan.refusedScreenIds.includes(xRenderer);
    return { binding, refused, unknown: binding === undefined && !refused && !scan.complete };
  };
  if (opts?.fresh === true) {
    collectInstalled({ fresh: true });
    return read();
  }
  const wasCached = scanIsCached();
  const first = read();
  if (first.binding !== undefined || first.refused || !wasCached) return first;
  cache = null;
  return read();
}

/**
 * The declared HITL CARD of a gate's renderer (cinatra#3470): the merged
 * binding with exactly this id, declared mid-run, whose screen is a "card"
 * that passes the same validation the client registration runs, and is the
 * declaration the parked step (`stepSchema`, its gate schema) opened under. The server's
 * bound-screen fill and lent-action submit read the card's answer from it,
 * never from the gate's input schema.
 *
 * `null` only for a gate that declares no screen at all. A declared screen the
 * validator refused, a declaration that does not validate again, an id an
 * incomplete scan does not name, or a failed read is "unavailable": the caller
 * lends nothing for that screen and never falls back to the gate's raw schema.
 *
 * A valid "kind" screen is `"kind-screen"`: the kind's own component draws it,
 * with its own submission logic (a grouped setup form flushes its fields and
 * validates them before it sends; a list step sends a pick). The server has no
 * faithful reading of that logic, so the caller lends no generic fill or
 * submit for it either: the person answers it on its own screen.
 */
export function readDeclaredHitlCard(
  xRenderer: string,
  stepSchema: unknown,
): DeclaredHitlCard | "kind-screen" | "unavailable" | null {
  try {
    // The step is answered only under the declaration it opened under: a
    // renderer changed since then lends nothing, not even the raw schema.
    if (stepDeclarationStanding(xRenderer, stepSchema) === "changed") return "unavailable";
    const { binding, refused, unknown } = lookupFieldRendererBinding(xRenderer);
    if (!binding) return refused || unknown ? "unavailable" : null;
    if (binding.screen === undefined) return null;
    if (isUndrawableDeclaredScreen(binding)) return "unavailable";
    // A screen belongs to a mid-run gate only; the validator refuses any other.
    if (binding.midRunHitl !== true) return "unavailable";
    const checked = validateHitlScreen(binding.screen, `${binding.id} screen`) as {
      screen?: { layout?: string };
      errors: string[];
    };
    if (checked.errors.length > 0) return "unavailable";
    if (checked.screen?.layout === "kind") return "kind-screen";
    if (checked.screen?.layout !== "card") return "unavailable";
    return checked.screen as DeclaredHitlCard;
  } catch {
    return "unavailable";
  }
}

/**
 * Resolve the canonical renderer ID bound to a KIND (e.g. the reviewer
 * output-envelope check in execution.ts). `undefined` when no present/
 * installed package binds the kind — callers treat that as "gate class not
 * present", the established degraded state.
 */
export function resolveRendererIdForKind(kind: string): string | undefined {
  return getMergedFieldRendererBindings().find((b) => b.kind === kind)?.id;
}

/**
 * Build the A2UI mid-run translator resolver the host injects into
 * A2UiAdapter: full xRenderer ID -> the manifest-declared translator KIND ->
 * the neutral translator primitive owned by agent-ui-protocol.
 */
export function buildA2UiMidRunTranslatorResolver(): MidRunTranslatorResolver {
  return (xRenderer) => {
    const binding = getMergedFieldRendererBindings().find(
      (b) => b.id === xRenderer && b.a2uiTranslator !== undefined,
    );
    if (!binding?.a2uiTranslator) return undefined;
    return A2UI_MID_RUN_TRANSLATOR_KINDS[binding.a2uiTranslator];
  };
}
