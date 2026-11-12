// RFC 8785 (JSON Canonicalization Scheme) for plain JSON data.
//
// Used by the tool-manifest report (packages/agent-ui-protocol/CONTRACT.md
// section 5.2, "Canonical JSON"): object keys sorted by UTF-16 code units at
// every depth, arrays in order, no white space, strings escaped as
// JSON.stringify escapes them and not normalized,
// numbers in the ECMAScript form, so -0 is 0 (RFC 8785 section 3.2.2).
//
// An object member whose value is undefined is left out, as JSON.stringify
// does. Everything that is not plain JSON data is refused with a
// CanonicalJsonError: a non-finite number, a bigint, a function, a symbol,
// undefined as an array element or as the whole value, an object whose
// prototype is not Object.prototype or null (Date, Map, class instances,
// so a toJSON method is never called), and a cycle.

export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalJsonError";
  }
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function serialize(value: unknown, path: string, seen: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError(`non-finite number at ${path}`);
      }
      // JSON.stringify of a finite number is the ECMAScript Number
      // serialization that RFC 8785 requires; it also writes -0 as 0.
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new CanonicalJsonError(`${typeof value} at ${path}`);
  }
  const obj = value as object;
  if (seen.has(obj)) throw new CanonicalJsonError(`cycle at ${path}`);
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      const parts = obj.map((item, i) => {
        if (item === undefined) {
          throw new CanonicalJsonError(`undefined array element at ${path}[${i}]`);
        }
        return serialize(item, `${path}[${i}]`, seen);
      });
      return `[${parts.join(",")}]`;
    }
    if (!isPlainObject(obj)) {
      throw new CanonicalJsonError(`non-plain object at ${path}`);
    }
    const record = obj as Record<string, unknown>;
    // Array.prototype.sort with no comparator compares UTF-16 code units,
    // which is the RFC 8785 key order.
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    const members = keys.map(
      (key) => `${JSON.stringify(key)}:${serialize(record[key], `${path}.${key}`, seen)}`,
    );
    return `{${members.join(",")}}`;
  } finally {
    seen.delete(obj);
  }
}

/** The RFC 8785 canonical JSON text of a plain JSON value. */
export function canonicalizeJson(value: unknown): string {
  if (value === undefined) throw new CanonicalJsonError("undefined value");
  return serialize(value, "$", new Set());
}
