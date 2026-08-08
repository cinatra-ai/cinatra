const FIELD_NAME_ACRONYMS = new Set(["url", "json", "id", "api", "http", "uri"]);

export function humanizeFieldName(key: string): string {
  return key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      const normalized = word.toLowerCase();
      if (FIELD_NAME_ACRONYMS.has(normalized)) return normalized.toUpperCase();
      return normalized.charAt(0).toUpperCase() + normalized.slice(1);
    })
    .join(" ");
}

/**
 * The internal WIRING token the single-field HITL panels pass as `fieldName`
 * when the interrupt carries no field identity of its own (cinatra#2541).
 *
 * It is a renderer-plumbing placeholder — a DOM-id and registry-lookup key —
 * and NEVER a field name a user typed, declared, or could recognize. Humanizing
 * it produces the nonsense label "Hitl Field", which is exactly the defect
 * #2541 reports.
 */
export const HITL_PLACEHOLDER_FIELD_NAME = "hitl-field";

/**
 * The label shown when a field has no recoverable human identity at all: no
 * meaningful `title`, no `description`, and only the internal placeholder for a
 * name. Neutral on purpose — a mid-run gate that asks the user for free text has
 * no declared field key to humanize, and a wrong-but-specific label ("Hitl
 * Field") is worse than an honest generic one.
 */
export const GENERIC_FIELD_LABEL = "Your response";

const INTERNAL_FIELD_NAME_PLACEHOLDERS: ReadonlySet<string> = new Set([
  HITL_PLACEHOLDER_FIELD_NAME,
]);

/**
 * Is this "field name" an internal wiring token rather than a real field key?
 *
 * The guard #2541 asks for: the token must never reach the label path as
 * something to humanize, from ANY caller — including a future one that
 * re-hardcodes the placeholder at a renderer call site.
 */
export function isInternalPlaceholderFieldName(fieldName: string): boolean {
  return INTERNAL_FIELD_NAME_PLACEHOLDERS.has(fieldName.trim().toLowerCase());
}

/**
 * Resolve the human-readable label for a setup/HITL form field.
 *
 * An explicit schema `title` wins — UNLESS it is the raw field key itself.
 * Some OAS compilers emit `title === fieldName` (e.g. `title: "companyUrl"`
 * for the `companyUrl` field), so a title equal to the key carries no more
 * meaning than the key and must be humanized rather than shown verbatim.
 * (An empty/whitespace-only title is likewise treated as absent.) After the
 * title, an optional `description` is the next fallback for callers that pass
 * one, and finally the humanized key.
 *
 * LAST LINE OF DEFENCE (cinatra#2541): an internal placeholder key is never
 * humanized. The real fix is upstream — the caller must pass the interrupt's
 * actual field name (see `hitlRendererFieldName`) — but when no field identity
 * exists at all (a mid-run gate, a read-only replay with no captured field key)
 * this returns the neutral `GENERIC_FIELD_LABEL` instead of leaking the wiring
 * token into the UI.
 */
export function resolveFieldLabel(
  fieldName: string,
  title?: string,
  description?: string
): string {
  const isPlaceholder = isInternalPlaceholderFieldName(fieldName);
  const hasMeaningfulTitle =
    title !== undefined &&
    title.trim() !== "" &&
    title !== fieldName &&
    !isInternalPlaceholderFieldName(title);
  if (hasMeaningfulTitle) return title;
  // A whitespace-only description is treated as absent for the same reason a
  // whitespace-only title is: it renders as a BLANK label, which is a worse
  // outcome than the humanized key (or the neutral label) it displaced.
  if (description !== undefined && description.trim() !== "") return description;
  return isPlaceholder ? GENERIC_FIELD_LABEL : humanizeFieldName(fieldName);
}
