/**
 * F9 TRANSPORT ATTRIBUTION (cinatra#2094).
 *
 * The S7 acceptance recorded F9 as "the OpenAI key cannot be saved from the
 * wizard — `read ECONNRESET`", with the puzzle stated in its own words: the same
 * key returned HTTP 200 from `curl https://api.openai.com/v1/models` seconds
 * apart. Two lanes read that as a defect in the connector's OpenAI VALIDATION
 * call. It is not, and this driver measures why — on REAL clients, no stub of
 * either one.
 *
 * The wizard's save performs TWO network hops, not one:
 *
 *   1. `listAvailableOpenAIModels` → `fetch https://api.openai.com/v1/models`
 *      (undici). This is the hop `curl` reproduces.
 *   2. `syncOpenAIConnectionToNango` → the connection service, through the Nango
 *      node SDK, which is AXIOS. `curl` never touches this hop.
 *
 * The committed S7 ledger already shows hop 1 returning **200** inside the
 * `B-openai-key-save` phase (`evidence/2094-s7-acceptance/e2e/results/openai-arm.json`,
 * `armProviderCalls`), so the reset came from hop 2. What this driver adds is the
 * MESSAGE-SHAPE evidence that turns that from an inference into a measurement:
 *
 *   A. the axios hop, on a genuine TCP RST, surfaces `error.message ===
 *      "read ECONNRESET"` — byte-identical to the string S7 found in
 *      `/setup/ai?error=read%20ECONNRESET` — and the connector's own
 *      `getNangoErrorMessage` passes it through verbatim (a transport error has
 *      no HTTP `response`, so it falls through to `error.message`).
 *   B. the undici hop CANNOT produce that string under ANY of the wire
 *      conditions below: a transport failure is always `TypeError: fetch failed`
 *      (or `terminated` on a mid-body break) with the system error demoted to
 *      `cause`. So the value observed in S7 could not have come from hop 1.
 *
 * WHAT IS REAL AND WHAT STANDS IN. Both CLIENTS are the shipped ones — the same
 * `@nangohq/node` the nango connector constructs (`new Nango(...)` + axios with
 * proxy auto-detection disabled, exactly as `getNangoClient()` does) and the
 * runtime's own `fetch`. Only the SERVER stands in: a listener driven through the
 * wire conditions an unreachable/aborting service actually produces (FIN, RST
 * after the request, RST on connect). The lane could NOT re-drive the S7 lane's
 * own remote condition — that instance and its env are gone — so this reports the
 * wire condition → message MAPPING and identifies which condition reproduces the
 * observed string, rather than claiming to know which one that host was in.
 *
 * NO CREDENTIAL IS USED OR NEEDED anywhere in this driver: the secretKey is a
 * literal dummy and every connection is torn down before a request could be
 * honoured, so nothing is ever sent to a real provider or connection service.
 */
import { createServer } from "node:net";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const OUT = process.env.LANE_RESULTS ?? "evidence/2094-f9-f10/results/transport-attribution.json";
// Lane-unique, deliberately clear of every stack port in use on this machine.
const PORT = Number(process.env.LANE_RESET_PORT ?? 39412);
const OBSERVED_IN_S7 = "read ECONNRESET";

const checks = [];
function check(id, what, pass, detail) {
  checks.push({ id, what, verdict: pass ? "PASS" : "FAIL", detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${id} — ${what}${detail ? ` :: ${detail}` : ""}`);
}

/**
 * The wire conditions a connection service that is down / going away actually
 * puts on the socket. `fin` = graceful close mid-request; `rst` = an abortive
 * reset once the request is in flight (a killed process, a proxy dropping the
 * connection, a TLS/plaintext mismatch); `rst-on-connect` = reset before any
 * request byte is read.
 */
const WIRE_CONDITIONS = ["fin", "rst", "rst-on-connect"];

function startServer(port, condition) {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      socket.on("error", () => {});
      if (condition === "rst-on-connect") {
        socket.resetAndDestroy();
        return;
      }
      socket.once("data", () => {
        if (condition === "rst") socket.resetAndDestroy();
        else socket.destroy();
      });
    });
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

/** The connector's own error-message extraction, transcribed from
 *  nango-connector/src/nango.ts `getNangoErrorMessage` — the function that
 *  decides which string reaches the wizard's `?error=`. */
function getNangoErrorMessage(error, fallback) {
  if (!error || typeof error !== "object") return fallback;
  const nestedError = error.response?.data?.error;
  const nestedMessage =
    nestedError?.errors?.find((entry) => entry?.message)?.message ?? nestedError?.message;
  return nestedMessage || error.message || fallback;
}

const { Nango } = await import("@nangohq/node");

/** Hop 2 exactly as `importNangoConnection` issues it. */
async function probeConnectionServiceHop(base) {
  const nango = new Nango({ secretKey: "dummy-not-a-credential", host: base });
  nango.http.defaults.proxy = false;
  try {
    await nango.http.post(
      `${nango.serverUrl}/connections`,
      {
        provider_config_key: "openai",
        connection_id: "cinatra",
        credentials: { type: "API_KEY", apiKey: "x" },
      },
      { headers: { Authorization: "Bearer dummy-not-a-credential" } },
    );
    return { message: null, surfaced: null };
  } catch (err) {
    return {
      message: err instanceof Error ? err.message : String(err),
      surfaced: getNangoErrorMessage(err, "Unable to configure the Nango integration."),
    };
  }
}

/** Hop 1 exactly as `listAvailableOpenAIModels` issues it (URL host aside). */
async function probeOpenAiValidationHop(base) {
  try {
    const res = await fetch(`${base}/v1/models`, {
      method: "GET",
      headers: { Authorization: "Bearer dummy-not-a-credential" },
      cache: "no-store",
    });
    // The connector also reads the body (`await response.text()`), which is the
    // other place a break can surface — measure it under the same condition.
    await res.text();
    return { message: null, cause: null };
  } catch (err) {
    const cause = err instanceof Error ? err.cause : undefined;
    return {
      message: err instanceof Error ? err.message : String(err),
      cause: cause instanceof Error ? cause.message : cause ? String(cause) : null,
    };
  }
}

const matrix = {};
for (const condition of WIRE_CONDITIONS) {
  const server = await startServer(PORT, condition);
  const base = `http://127.0.0.1:${PORT}`;
  try {
    matrix[condition] = {
      connectionServiceHop: await probeConnectionServiceHop(base),
      openAiValidationHop: await probeOpenAiValidationHop(base),
    };
  } finally {
    server.close();
    await new Promise((r) => server.on("close", r));
  }
  console.log(
    `[wire ${condition}] connection-service=${JSON.stringify(matrix[condition].connectionServiceHop.surfaced)} ` +
      `openai-validation=${JSON.stringify(matrix[condition].openAiValidationHop.message)}`,
  );
}

const reproducing = WIRE_CONDITIONS.filter(
  (c) => matrix[c].connectionServiceHop.surfaced === OBSERVED_IN_S7,
);

check(
  "T1a",
  "a REAL wire condition of the connection-service hop reproduces the S7 string exactly",
  reproducing.length > 0,
  `conditions reproducing "${OBSERVED_IN_S7}": ${JSON.stringify(reproducing)}`,
);
check(
  "T1b",
  "the connector's own getNangoErrorMessage passes the transport message through VERBATIM (no HTTP response to prefer)",
  reproducing.every(
    (c) => matrix[c].connectionServiceHop.surfaced === matrix[c].connectionServiceHop.message,
  ) && reproducing.length > 0,
  JSON.stringify(reproducing.map((c) => matrix[c].connectionServiceHop)),
);
check(
  "T1c",
  "the S7 landing URL is reproduced byte-for-byte from that surfaced string",
  reproducing.some(
    (c) =>
      `/setup/ai?error=${encodeURIComponent(matrix[c].connectionServiceHop.surfaced)}` ===
      "/setup/ai?error=read%20ECONNRESET",
  ),
  reproducing
    .map((c) => `/setup/ai?error=${encodeURIComponent(matrix[c].connectionServiceHop.surfaced)}`)
    .join(" "),
);
check(
  "T2a",
  "the OpenAI validation hop (undici fetch) produces the S7 string under NO wire condition",
  WIRE_CONDITIONS.every((c) => matrix[c].openAiValidationHop.message !== OBSERVED_IN_S7),
  WIRE_CONDITIONS.map((c) => `${c}=${JSON.stringify(matrix[c].openAiValidationHop)}`).join(" "),
);
check(
  "T2b",
  "ATTRIBUTION: the S7 `?error=read%20ECONNRESET` is the CONNECTION-SERVICE hop, not the OpenAI hop",
  reproducing.length > 0 &&
    WIRE_CONDITIONS.every((c) => matrix[c].openAiValidationHop.message !== OBSERVED_IN_S7),
);

const results = {
  at: new Date().toISOString(),
  port: PORT,
  observedInS7: OBSERVED_IN_S7,
  note:
    "Both clients are the shipped ones (@nangohq/node + the runtime fetch); only the SERVER is a " +
    "stand-in driven through real wire conditions. The S7 lane's own remote condition is not " +
    "knowable from the committed artifacts (that instance and its env are gone), so this records " +
    "the condition -> message MAPPING and identifies which condition reproduces the observed string.",
  wireConditionMatrix: matrix,
  reproducingConditions: reproducing,
  checks,
};
mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(results, null, 2));
const failed = checks.filter((c) => c.verdict === "FAIL").length;
console.log(`\nPASS=${checks.length - failed} FAIL=${failed}\nwrote ${OUT}`);
process.exit(failed === 0 ? 0 : 1);
