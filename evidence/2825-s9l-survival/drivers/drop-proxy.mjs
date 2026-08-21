// ---------------------------------------------------------------------------
// THE TRANSPORT-DROP PROXY — the honest way to make a real chat turn FAIL after
// it has already produced a card (cinatra#2825, S9l).
//
// WHY IT EXISTS. The error cells need a turn that reached a lifecycle card and
// then LOST ITS STREAM. Nothing on a keyless stack fails that way on its own:
// the deterministic turn streams its text, calls the real pull primitives and
// finishes in one breath, so there is no window a driver could hit by racing it.
// So the failure is induced where a real one happens — on the wire. This is a
// transparent forwarder in front of the app; for a marked turn it forwards every
// byte up to and including the frame that carries the card and then DESTROYS the
// socket, which is exactly what a dropped connection does to an SSE body.
//
// WHAT IT DOES NOT DO. It never edits a frame, never drops one out of the
// middle, never synthesizes one. Everything the reader sees was written by the
// app; the only thing this adds is the moment the wire stops. The client's own
// durable-log RESUME is failed the same way (the socket is destroyed for the
// resume GET too) because a resume that succeeds is a turn that did NOT fail —
// the shipped client falls back to the accumulated state and renders no error.
//
// Usage: PROXY_PORT=… UPSTREAM_PORT=… CUT_AFTER='<substring>' node drop-proxy.mjs
// Set CUT_AFTER empty to forward everything untouched.
// ---------------------------------------------------------------------------
import http from "node:http";

const PROXY_PORT = Number(process.env.PROXY_PORT ?? 3187);
const UPSTREAM_PORT = Number(process.env.UPSTREAM_PORT ?? 3186);
const CUT_AFTER = process.env.CUT_AFTER ?? "";
const CUT_PATH = process.env.CUT_PATH ?? "/api/assistants/chat";
const RESUME_RE = /^\/api\/assistants\/runs\/[^/]+\/stream/;
// `allow` lets the shipped durable-log resume run after the cut, so a lane can
// see what the REPLAY alone produces; the default fails it, because a resume
// that succeeds is a turn that did not fail.
const RESUME_MODE = process.env.RESUME_MODE ?? "refuse";

let armed = CUT_AFTER.length > 0;
let cut = false;

const server = http.createServer((req, res) => {
  const isCutTarget = armed && req.method === "POST" && req.url.startsWith(CUT_PATH);
  // A resume AFTER the cut is failed the same way: the shipped client treats a
  // successful resume as a completed turn, so letting it through would erase
  // the very failure this run is photographing.
  if (cut && RESUME_MODE === "refuse" && RESUME_RE.test(req.url)) {
    console.log(`[proxy] refusing resume ${req.url} (socket destroyed)`);
    req.socket.destroy();
    return;
  }
  const headers = { ...req.headers };
  const upstream = http.request(
    { host: "localhost", port: UPSTREAM_PORT, method: req.method, path: req.url, headers },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      if (!isCutTarget) {
        up.pipe(res);
        return;
      }
      // BYTE-ACCURATE. Forward everything up to and including the LAST BYTE of
      // the frame that carries the marker, and not one byte more: SSE frames can
      // arrive coalesced in one TCP chunk, so writing the whole chunk could hand
      // the client the terminal RUN_FINISHED as well — and a turn that finished
      // is a turn that did not fail. The socket is destroyed a moment later so
      // the bytes already written are flushed and parsed first.
      let all = Buffer.alloc(0);
      let written = 0;
      up.on("data", (chunk) => {
        if (cut) return;
        all = Buffer.concat([all, chunk]);
        const text = all.toString("utf8");
        const at = text.indexOf(CUT_AFTER);
        const frameEnd = at >= 0 ? text.indexOf("\n\n", at) : -1;
        if (frameEnd < 0) {
          res.write(all.subarray(written));
          written = all.length;
          return;
        }
        const stop = frameEnd + 2;
        res.write(all.subarray(written, stop));
        written = stop;
        cut = true;
        console.log(`[proxy] CUT after "${CUT_AFTER}" (${written} bytes forwarded)`);
        setTimeout(() => {
          res.destroy();
          upstream.destroy();
        }, 400);
      });
      up.on("end", () => { if (!cut) res.end(); });
      up.on("error", () => { if (!cut) res.destroy(); });
    },
  );
  upstream.on("error", (err) => {
    if (!res.headersSent) res.writeHead(502);
    if (!cut) res.end(String(err?.message ?? err));
  });
  req.pipe(upstream);
});

server.listen(PROXY_PORT, "localhost", () => {
  console.log(`[proxy] listening ${PROXY_PORT} -> ${UPSTREAM_PORT}; cutAfter=${JSON.stringify(CUT_AFTER)}`);
});
