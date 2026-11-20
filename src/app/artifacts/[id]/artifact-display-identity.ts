import "server-only";

/**
 * WHAT THE DISPLAY THAT DRAWS A ROW SAYS OF ITSELF, for the identity line of
 * the artifact's own page (cinatra#4366; artifact-review §XI.7: "the identity
 * line of every page names the renderer that drew it", and the platform it
 * names is the only thing that tells a WordPress page from a Drupal page).
 *
 * CORE NAMES NO EXTENSION. It reads two OPTIONAL named exports, generically,
 * from the very module the slot mounts for the page's detail display:
 *
 *   rendererName            a string: the renderer's name ("drawn by …")
 *   identityFacts(content)  `{ revision: string[], closing: string[] }` or null,
 *                           from the content the page already hands the display
 *
 * Neither is a manifest key, so no kind gate, generator or byte-pinned map
 * moves. A module that exports neither, or exports either in a shape this
 * reader does not take, declares nothing, and the line stays exactly as it was.
 *
 * THE NAME IS DRAWN ONLY FROM THE DECISION THE SLOT MOUNTS WITH. The page
 * makes ONE build-map load decision per render (`loadArtifactRenderer`: the
 * quarantine read, the entry in this build, the props version negotiation, the
 * module load, the degraded absence, the component export) and hands that one
 * decision both to this read and to the slot (`ExtensionRendererSlot`'s
 * `decision`). Neither reads quarantine or loads the module again, so the
 * header names a renderer exactly where the slot mounts that same module: a
 * decision the slot degrades, or a negotiated version the slot would not mount
 * (`rendererLoadMountsAt`), declares nothing. A runtime mount and every floor
 * have no build-map decision and declare nothing.
 *
 * FAIL-QUIET, NEVER LOUD: this read decorates a header. It rethrows nothing: a
 * decision that rejects (a present but broken module) answers nothing here,
 * and the slot, awaiting the same decision, still fails loud on its own road.
 */
import type { ArtifactRendererLoadResult } from "@/lib/artifacts/artifact-renderer-loader";

import {
  NO_DISPLAY_IDENTITY,
  type ArtifactDisplayIdentity,
} from "./artifact-detail-header";
import { rendererLoadMountsAt } from "./extension-renderer-slot";

/** The longest cell the line takes from a display, and the most cells per place. */
const CELL_MAX_CHARS = 200;
const CELLS_MAX = 4;

/** One drawable cell: a non-empty single-line text, already trimmed, that
 *  cannot forge the line's own separator or reorder the line. Anything else is
 *  no cell. */
function cell(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value === "" || value.trim() !== value) return null;
  if (value.length > CELL_MAX_CHARS) return null;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    // A control character or a line break would break the one mono line; the
    // middle dot is the line's own separator, which a cell must not forge.
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return null;
    if (code === 0x2028 || code === 0x2029 || code === 0xb7) return null;
    // A bidirectional mark, embedding, override or isolate would reorder the
    // cells around it, so the drawn line could read other than it is built.
    if (isBidiControl(code)) return null;
  }
  return value;
}

/** U+061C, U+200E, U+200F, U+202A to U+202E and U+2066 to U+2069. */
function isBidiControl(code: number): boolean {
  return (
    code === 0x061c ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

function cells(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length > CELLS_MAX) return null;
  const out: string[] = [];
  for (const entry of value) {
    const text = cell(entry);
    if (text === null) return null;
    out.push(text);
  }
  return out;
}

function readFacts(
  identityFacts: unknown,
  content: unknown,
): ArtifactDisplayIdentity["facts"] {
  if (typeof identityFacts !== "function") return null;
  try {
    const result: unknown = (identityFacts as (content: unknown) => unknown)(content);
    if (typeof result !== "object" || result === null || Array.isArray(result)) return null;
    // A promise is not an answer: the line is drawn now. A rejection it may
    // carry is consumed, never left unhandled.
    const then = (result as { then?: unknown }).then;
    if (typeof then === "function") {
      Promise.resolve(result).catch(() => undefined);
      return null;
    }
    const revision = cells((result as { revision?: unknown }).revision);
    const closing = cells((result as { closing?: unknown }).closing);
    if (revision === null || closing === null) return null;
    return { revision, closing };
  } catch {
    // The export threw, or a getter on its answer threw: no facts. The
    // renderer's name, read apart, still stands.
    return null;
  }
}

/**
 * The identity a LOADED display module declares, for the content the page
 * hands it. Pure and total: every input answers, and a module that declares
 * nothing (or declares it malformed) answers `NO_DISPLAY_IDENTITY`'s parts.
 */
export function displayIdentityFromModule(
  mod: unknown,
  content: unknown,
): ArtifactDisplayIdentity {
  if (typeof mod !== "object" || mod === null) return NO_DISPLAY_IDENTITY;
  // Each export is read apart: a getter that throws on one declares nothing
  // of that one, and leaves the other as it reads.
  return {
    drawnBy: cell(readExport(mod, "rendererName")),
    facts: readFacts(readExport(mod, "identityFacts"), content),
  };
}

function readExport(mod: object, name: "rendererName" | "identityFacts"): unknown {
  try {
    return (mod as Record<string, unknown>)[name];
  } catch {
    return undefined;
  }
}

/**
 * Read the identity of the display from the page's ONE build-map load decision,
 * the very decision the slot mounts with. Every decision the slot would not
 * mount, and no decision at all, answers `NO_DISPLAY_IDENTITY`.
 */
export async function readArtifactDisplayIdentity(input: {
  /** The page's one build-map load decision, also handed to the slot; null
   *  for a runtime mount or a floor. */
  readonly decision: Promise<ArtifactRendererLoadResult> | null;
  /** The content projection the page hands the display (its props' content). */
  readonly content: unknown;
  /** The props version of the page's snapshot, the one the slot mounts at. */
  readonly propsApiVersion: number;
}): Promise<ArtifactDisplayIdentity> {
  if (input.decision === null) return NO_DISPLAY_IDENTITY;
  try {
    const result = await input.decision;
    if (!rendererLoadMountsAt(result, input.propsApiVersion)) return NO_DISPLAY_IDENTITY;
    return displayIdentityFromModule(result.module, input.content);
  } catch {
    return NO_DISPLAY_IDENTITY;
  }
}
