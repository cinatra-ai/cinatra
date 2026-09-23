// How a dashboard identifier reaches a page from the address (cinatra#2811,
// fix leg 2).
//
// The framework hands a dynamic segment to a page ALREADY percent-escaped. It
// decodes the raw path segment when the segment matches the route
// (next/dist/shared/lib/router/utils/route-matcher.js:19), and then re-escapes
// that value on its way to user code
// (next/dist/shared/lib/router/utils/get-dynamic-param.js:58, whose own comment
// calls it "the value that is passed to user code"). Both address forms
// therefore arrive the same way: the escaped one the row's Open control writes,
// and the plainly punctuated one a person types. The store holds the plain
// identifier, so a page that compares or looks up the raw segment misses every
// identifier that carries punctuation, such as an entity's composed Overview.
//
// A plain identifier is unaffected, which is why a created dashboard opens
// while an Overview does not.
//
// A segment the page cannot honour is used exactly as it arrived, so it names
// no row and the page answers not-found rather than failing. Two segments are
// like that, and both are reachable only by crafting an address:
//
//   - One that is not a valid escape sequence. decodeURIComponent raises on a
//     truncated or invalid escape, and a page that throws renders the error
//     surface instead of the not-found page. On the running server such an
//     address never even reaches the page: the route match refuses it first and
//     the framework answers 400 (next/dist/server/base-server.js:1601). The
//     guard holds for every other way a value reaches `params`, among them the
//     fallback route params, which are NOT escaped
//     (next/dist/shared/lib/router/utils/get-dynamic-param.js:50).
//   - One that decodes to a string holding a NUL, which `%00` does. A stored
//     identifier can never hold one, because a PostgreSQL text value cannot
//     carry it, so such a segment names no row by construction. Handing it to
//     the store would fail the query instead of missing, and the page would
//     answer with a failure where not-found is the honest answer.
export function decodeDashboardRouteSegment(segment: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return segment;
  }
  return decoded.includes("\u0000") ? segment : decoded;
}
