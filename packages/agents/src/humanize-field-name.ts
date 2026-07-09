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
 * Resolve the human-readable label for a setup/HITL form field.
 *
 * An explicit schema `title` wins — UNLESS it is the raw field key itself.
 * Some OAS compilers emit `title === fieldName` (e.g. `title: "companyUrl"`
 * for the `companyUrl` field), so a title equal to the key carries no more
 * meaning than the key and must be humanized rather than shown verbatim.
 * (An empty/whitespace-only title is likewise treated as absent.) After the
 * title, an optional `description` is the next fallback for callers that pass
 * one, and finally the humanized key.
 */
export function resolveFieldLabel(
  fieldName: string,
  title?: string,
  description?: string
): string {
  if (title && title.trim() !== "" && title !== fieldName) return title;
  if (description) return description;
  return humanizeFieldName(fieldName);
}
