/**
 * What the WayFlow continue road records as the submitted values of a gate
 * answer (cinatra#4244). The resume text itself (`userResponse`) goes to the
 * flow verbatim; this reading only decides what is recorded beside it.
 *
 *  1. A NAMED SINGLE TEXT ANSWER. A schema-drawn gate that asks for one text
 *     field sends that text verbatim as `userResponse` and names its field in
 *     `userResponseFieldName`. When the values carry that field as an own key
 *     whose value IS the resume text, the answer is recorded under that field
 *     alone - even when the text reads as JSON (`42`, `{"tone":"warm"}`), which
 *     the reading below would otherwise take for the submitted values. A name
 *     whose value is not the resume text is not believed.
 *  2. Otherwise, as before: a `userResponse` that parses as a JSON object is the
 *     submitted values; one that is not JSON leaves the values without
 *     `userResponse`; no `userResponse` leaves the values themselves; nothing
 *     left is `null`.
 */
export function readWayflowSubmittedValues(values: unknown): Record<string, unknown> | null {
  const valuesObj =
    values !== null && typeof values === "object" && !Array.isArray(values)
      ? (values as Record<string, unknown>)
      : null;
  if (!valuesObj) return null;
  const own = (key: string): unknown =>
    Object.prototype.hasOwnProperty.call(valuesObj, key) ? valuesObj[key] : undefined;
  const userResponseRaw = own("userResponse");
  if (typeof userResponseRaw === "string" && userResponseRaw.trim().length > 0) {
    const fieldName = own("userResponseFieldName");
    if (
      typeof fieldName === "string" &&
      fieldName !== "userResponse" &&
      fieldName !== "userResponseFieldName" &&
      own(fieldName) === userResponseRaw
    ) {
      const recorded: Record<string, unknown> = {};
      Object.defineProperty(recorded, fieldName, {
        value: userResponseRaw,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      return recorded;
    }
    try {
      const parsed = JSON.parse(userResponseRaw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return null;
    } catch {
      const { userResponse: _u, ...rest } = valuesObj;
      void _u;
      return Object.keys(rest).length > 0 ? rest : null;
    }
  }
  const { userResponse: _u, ...rest } = valuesObj;
  void _u;
  return Object.keys(rest).length > 0 ? rest : null;
}
