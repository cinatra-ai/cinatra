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
// A segment that is not a valid escape sequence must answer not-found rather
// than throw: decodeURIComponent raises on a truncated or invalid escape, and a
// page that throws renders the error surface instead of the not-found page. The
// raw segment is used instead, and it names no row.
export function decodeDashboardRouteSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
