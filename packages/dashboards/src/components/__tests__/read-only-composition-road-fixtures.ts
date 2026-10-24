// FIXTURES FOR THE READ-ONLY COMPOSITION'S DATA ROADS (cinatra#3092, #4118 fold).
//
// The composition admits exactly two roads, read by equality: `{ road: "none" }`
// and `{ road: "session", apiUrl }` where `apiUrl` is a root-relative path or an
// absolute http or https URL that resolves, against the page's own origin, to
// that origin with no user name or password. Every value below is one it must
// REFUSE: it mounts no provider, draws a settled refusal, and never falls
// through to the session road, which sends the reader's credentials.
// Not a test file: the suites that read it import it.

export const API = "/api/dashboards/cubejs-api/v1";

/** The page's own origin under jsdom, and the same address written absolute. */
export const PAGE_ORIGIN =
  typeof window === "undefined" ? "http://localhost:3000" : window.location.origin;
export const SAME_ORIGIN_API = `${PAGE_ORIGIN}${API}`;

const PAGE = new URL(PAGE_ORIGIN);
const OTHER_SCHEME = PAGE.protocol === "https:" ? "http:" : "https:";
const OTHER_PORT = PAGE.port === "4999" ? "4998" : "4999";

function accessorRoad(): object {
  const value = {};
  Object.defineProperty(value, "road", { enumerable: true, get: () => "session" });
  Object.defineProperty(value, "apiUrl", { enumerable: true, value: API });
  return value;
}

/** [name, value] — the name is the test's, the value the `dataRoad` prop. */
export const REFUSED_ROADS: ReadonlyArray<readonly [string, unknown]> = [
  ["a road object with no road field", { apiUrl: API }],
  ["a case-varied session", { road: "Session", apiUrl: API }],
  ["a case-varied none", { road: "NONE" }],
  ["a padded session", { road: " session", apiUrl: API }],
  ["a future road name", { road: "sealed", apiUrl: API }],
  ["a non-string road", { road: 1, apiUrl: API }],
  ["a road name inside an array", { road: ["session"], apiUrl: API }],
  ["a session road with no address", { road: "session" }],
  ["a session road with an empty address", { road: "session", apiUrl: "" }],
  ["a session road with a non-string address", { road: "session", apiUrl: 7 }],
  ["a road behind an accessor", accessorRoad()],
  ["an inherited road", Object.create({ road: "session", apiUrl: API })],
  ["a bare string", "session"],
  ["null", null],
  ["false", false],
  ["the number zero", 0],
  ["an array holding a road", [{ road: "session", apiUrl: API }]],
  // The session road sends the reader's credentials: only the page's own origin.
  ["a session road to another origin", { road: "session", apiUrl: "https://evil.example/cubejs-api/v1" }],
  ["a session road to a protocol-relative address", { road: "session", apiUrl: "//evil.example/cubejs-api/v1" }],
  ["a session road to a backslash address", { road: "session", apiUrl: "/\\evil.example/cubejs-api/v1" }],
  ["a session road to a tab-split address", { road: "session", apiUrl: "/\t/evil.example/cubejs-api/v1" }],
  ["a session road to a space-led address", { road: "session", apiUrl: " //evil.example/cubejs-api/v1" }],
  ["a session road to a javascript address", { road: "session", apiUrl: "javascript:alert(1)" }],
  ["a session road to a data address", { road: "session", apiUrl: "data:text/plain,x" }],
  // Only http and https, read from the parsed URL: a blob address names the page's
  // own origin as its origin, and is still refused.
  ["a session road to a blob address of the page origin", { road: "session", apiUrl: `blob:${PAGE_ORIGIN}/0b1c2d3e` }],
  ["a session road to a data address naming the page origin", { road: "session", apiUrl: `data:text/plain,${PAGE_ORIGIN}${API}` }],
  ["a session road to a case-varied javascript address", { road: "session", apiUrl: "JavaScript:alert(1)" }],
  ["a session road to a file address", { road: "session", apiUrl: "file:///etc/passwd" }],
  ["a session road to the page host on another scheme", { road: "session", apiUrl: `${OTHER_SCHEME}//${PAGE.host}${API}` }],
  ["a session road to the page host on another port", { road: "session", apiUrl: `${PAGE.protocol}//${PAGE.hostname}:${OTHER_PORT}${API}` }],
  ["a session road with a user name and password", { road: "session", apiUrl: `${PAGE.protocol}//user:pw@${PAGE.host}${API}` }],
  ["a session road with an empty user name and a password", { road: "session", apiUrl: `${PAGE.protocol}//:pw@${PAGE.host}${API}` }],
  ["a session road with the page origin as a user name", { road: "session", apiUrl: `${PAGE_ORIGIN}@evil.example${API}` }],
  ["a session road to a host that starts like the page host", { road: "session", apiUrl: `${PAGE_ORIGIN}.evil.example${API}` }],
  ["a session road to a relative path", { road: "session", apiUrl: "api/dashboards/cubejs-api/v1" }],
  ["a session road to an address that does not parse", { road: "session", apiUrl: "http://[bad" }],
];

export const QUERY = JSON.stringify({ measures: ["Items.count"], dimensions: ["Items.kind"] });

/** Three CONFIGURED portlets: each chart type's mandatory drop zones are filled. */
export const CONFIGURED_PORTLETS = [
  {
    id: "p1",
    title: "Portlet one",
    x: 0,
    y: 0,
    w: 6,
    h: 3,
    chartType: "kpiNumber",
    query: QUERY,
    chartConfig: { yAxis: ["Items.count"] },
  },
  {
    id: "p2",
    title: "Portlet two",
    x: 6,
    y: 0,
    w: 6,
    h: 3,
    chartType: "table",
    query: QUERY,
    chartConfig: { xAxis: ["Items.kind", "Items.count"] },
  },
  {
    id: "p3",
    title: "Portlet three",
    x: 0,
    y: 3,
    w: 12,
    h: 3,
    chartType: "bar",
    query: QUERY,
    chartConfig: { xAxis: ["Items.kind"], yAxis: ["Items.count"] },
  },
];

export const CONFIGURED = {
  portlets: CONFIGURED_PORTLETS,
  layoutMode: "grid",
  grid: { cols: 12, rowHeight: 80, minW: 2, minH: 2 },
};

/** IntersectionObserver that reports every target as visible, so a portlet that
 *  would load does load. */
export class VisibleObserver {
  constructor(private readonly callback: (entries: unknown[], observer: unknown) => void) {}
  observe(target: Element) {
    this.callback([{ isIntersecting: true, intersectionRatio: 1, target }], this);
  }
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

export type FetchCall = { url: string; credentials: string | undefined };

/** A recording `fetch` that answers an empty reading for every cube route. */
export function recordingFetch(calls: FetchCall[]) {
  return async (input: unknown, init?: { credentials?: string }) => {
    const url = String(input);
    calls.push({ url, credentials: init?.credentials });
    const body = url.includes("/meta") ? { cubes: [] } : { data: [], annotation: {} };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}
