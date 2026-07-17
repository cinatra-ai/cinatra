#!/usr/bin/env node
/**
 * Execution-plane egress gateway (exec-plane S1, cinatra#1706 — epic D3).
 *
 * A dependency-free attributing forward proxy. Runs as the ONLY dual-homed
 * container between the internal (no-NAT) sandbox network and the outside —
 * the network topology makes it the enforcement point; this process makes the
 * enforcement attributable and PER-JOB policy-aware:
 *
 *  - REGISTERED TOKENS ONLY: the broker registers each job token together with
 *    its resolved policy (mode + allowlist + byte cap) on the CONTROL channel
 *    (`POST /__register`, authenticated with the control secret the sandbox
 *    NEVER sees). A request whose proxy-auth username is not a registered token
 *    is refused 407. A sandbox therefore cannot forge attribution, cannot reset
 *    its byte counter by minting a fresh token, and cannot borrow another job's
 *    policy — the username is validated against the registry, not merely parsed
 *    (closes the "any non-empty username is accepted" hole).
 *  - PER-TOKEN POLICY: allowlist / mode / byte cap are looked up per token, so
 *    one shared gateway enforces each job's OWN policy (an allowlisted job and a
 *    default-internet job on the same gateway get different verdicts).
 *  - SSRF/PIVOT DEFENSE: every destination host is DNS-resolved and rejected if
 *    it lands in a loopback / private / link-local / cloud-metadata range; the
 *    actual connection is pinned to the validated IP (no TOCTOU rebind). The
 *    gateway thus cannot be used to pivot into trusted networks or hit the
 *    cloud metadata endpoint, even in allow_all mode.
 *  - IN-TRANSFER BYTE CAP: bytes are metered as they flow; a stream is severed
 *    the moment a job crosses its cap (not merely checked at request open).
 *  - CONTROL ISOLATION: `/__register` and `/__stats` require the control
 *    secret; a sandbox on the internal network that reaches the admin port
 *    without the secret gets 401. Only `/__health` is unauthenticated.
 *
 * Protocol surface: HTTP CONNECT (TLS tunneling — pip/npm/curl https) and
 * absolute-URI plain-HTTP proxying. Other protocols have no route (the internal
 * network denies them by construction).
 *
 * Config (env): EGRESS_CONTROL_SECRET (required for control ops),
 * EGRESS_MODE=allow_all|allowlist (default policy for tokens registered without
 * an explicit one), EGRESS_ALLOWLIST, EGRESS_MAX_BYTES_PER_JOB,
 * EGRESS_PROXY_PORT=3128, EGRESS_ADMIN_PORT=3129.
 *
 * Exported for in-process unit tests: createGateway(config) → { proxyServer,
 * adminServer, stats, registry }. When run directly, listens per env config.
 */
"use strict";

/* eslint-disable @typescript-eslint/no-require-imports -- plain CommonJS
 * runtime script executed by `node` inside the gateway container; it must not
 * depend on the TS/ESM toolchain. */
const http = require("node:http");
const net = require("node:net");
const dns = require("node:dns").promises;
const { URL } = require("node:url");
const { timingSafeEqual } = require("node:crypto");

function parseConfig(env) {
  const allowlist = String(env.EGRESS_ALLOWLIST || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  return {
    controlSecret: String(env.EGRESS_CONTROL_SECRET || ""),
    defaultMode: env.EGRESS_MODE === "allowlist" ? "allowlist" : "allow_all",
    defaultAllowlist: allowlist,
    defaultMaxBytesPerJob: Math.max(0, Number(env.EGRESS_MAX_BYTES_PER_JOB || 0) || 0),
    proxyPort: Number(env.EGRESS_PROXY_PORT || 3128),
    adminPort: Number(env.EGRESS_ADMIN_PORT || 3129),
  };
}

function hostAllowed(host, mode, allowlist) {
  if (mode !== "allowlist") return true;
  const h = String(host || "").toLowerCase().replace(/\.$/, "");
  if (h.length === 0) return false;
  for (const raw of allowlist) {
    const entry = String(raw).replace(/^\*\./, "").replace(/\.$/, "");
    if (entry.length === 0) continue;
    if (h === entry || h.endsWith("." + entry)) return true;
  }
  return false;
}

/** Proxy-Authorization: Basic base64("<jobToken>:<pw>") → jobToken (or null). */
function jobTokenFrom(headerValue) {
  if (typeof headerValue !== "string") return null;
  const match = /^Basic\s+([A-Za-z0-9+/=]+)$/.exec(headerValue.trim());
  if (!match) return null;
  let decoded;
  try {
    decoded = Buffer.from(match[1], "base64").toString("utf8");
  } catch {
    return null;
  }
  const token = decoded.split(":")[0];
  return token && token.length > 0 ? token : null;
}

function constantTimeEquals(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length || ba.length === 0) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Expand an IPv6 literal (incl. `::` compression, expanded zero groups, zone
 * ids, and an embedded IPv4 tail) into its 16 bytes, or null when unparseable.
 * String-prefix matching is NOT sufficient for SSRF classification — an
 * attacker can write `0:0:0:0:0:0:0:1`, `fe90::1`, or `::ffff:a9fe:a9fe`; only
 * numeric classification over the expanded bytes is safe.
 */
function ipv6ToBytes(input) {
  let s = String(input).toLowerCase();
  const pct = s.indexOf("%");
  if (pct >= 0) s = s.slice(0, pct); // drop zone id
  // Embedded IPv4 tail (e.g. ::ffff:1.2.3.4 or ::1.2.3.4) → two hextets.
  const embedded = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (embedded) {
    if (!net.isIPv4(embedded[2])) return null;
    const p = embedded[2].split(".").map(Number);
    if (p.some((n) => n > 255)) return null;
    const hi = ((p[0] << 8) | p[1]).toString(16);
    const lo = ((p[2] << 8) | p[3]).toString(16);
    s = embedded[1] + hi + ":" + lo;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  let hextets;
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    hextets = [...head, ...Array(missing).fill("0"), ...tail];
  } else {
    hextets = head;
  }
  if (hextets.length !== 8) return null;
  const bytes = [];
  for (const h of hextets) {
    if (!/^[0-9a-f]{1,4}$/.test(h)) return null;
    const v = parseInt(h, 16);
    bytes.push((v >> 8) & 0xff, v & 0xff);
  }
  return bytes;
}

/** Classify the 16 expanded IPv6 bytes as a protected range (numeric CIDRs). */
function isProtectedIPv6Bytes(b) {
  const firstFifteenZero = b.slice(0, 15).every((x) => x === 0);
  if (firstFifteenZero && (b[15] === 0 || b[15] === 1)) return true; // :: and ::1
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if ((b[0] & 0xfe) === 0xfc) return true; // fc00::/7 ULA
  // IPv4-mapped ::ffff:0:0/96 — re-check the embedded v4 numerically.
  if (b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff) {
    return isProtectedAddress(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`);
  }
  // IPv4-compatible ::/96 (deprecated) embedding a v4 address.
  if (
    b.slice(0, 12).every((x) => x === 0) &&
    !(b[12] === 0 && b[13] === 0 && b[14] === 0 && (b[15] === 0 || b[15] === 1))
  ) {
    return isProtectedAddress(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`);
  }
  return false;
}

/**
 * Reject an IP literal that lands in a protected range (SSRF pivot / metadata).
 * Covers IPv4 loopback/private/link-local/CGNAT/multicast + the cloud metadata
 * address, and IPv6 loopback/ULA/link-local + IPv4-mapped/compatible forms —
 * numeric classification, not string-prefix matching. Unparseable ⇒ rejected.
 */
function isProtectedAddress(ip) {
  const addr = String(ip);
  if (net.isIPv4(addr)) {
    const octets = addr.split(".").map(Number);
    if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return true;
    }
    const [a, b] = octets;
    if (a === 127) return true; // loopback
    if (a === 10) return true; // private
    if (a === 0) return true; // "this network"
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 169 && b === 254) return true; // link-local + 169.254.169.254 metadata
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  const bytes = ipv6ToBytes(addr);
  if (bytes) return isProtectedIPv6Bytes(bytes);
  return true; // unparseable ⇒ reject
}

/**
 * Resolve a hostname to a single, validated, non-protected IP to connect to
 * (pins the IP so the policy decision and the actual connection cannot diverge
 * via DNS rebinding). Returns null when the host is protected or unresolvable.
 */
async function resolvePinnedAddress(host) {
  if (net.isIP(host)) {
    return isProtectedAddress(host) ? null : host;
  }
  let records;
  try {
    records = await dns.lookup(host, { all: true });
  } catch {
    return null;
  }
  for (const record of records) {
    if (!isProtectedAddress(record.address)) return record.address;
  }
  return null;
}

function createRegistry() {
  /** token → { mode, allowlist, maxBytesPerJob } */
  const policies = new Map();
  return {
    register(token, policy) {
      policies.set(token, {
        mode: policy.mode === "allowlist" ? "allowlist" : "allow_all",
        allowlist: Array.isArray(policy.allowlist)
          ? policy.allowlist.map((h) => String(h).toLowerCase())
          : [],
        maxBytesPerJob: Math.max(0, Number(policy.maxBytesPerJob || 0) || 0),
      });
    },
    unregister(token) {
      policies.delete(token);
    },
    get(token) {
      return policies.get(token) || null;
    },
    has(token) {
      return policies.has(token);
    },
  };
}

function createStats() {
  const jobs = new Map();
  function bucket(token) {
    let destinations = jobs.get(token);
    if (!destinations) {
      destinations = new Map();
      jobs.set(token, destinations);
    }
    return destinations;
  }
  function record(token, host, port, allowed) {
    const destinations = bucket(token);
    const key = host + ":" + port;
    let entry = destinations.get(key);
    if (!entry) {
      entry = { host, port, allowed: 0, denied: 0, bytesIn: 0, bytesOut: 0 };
      destinations.set(key, entry);
    }
    if (allowed) entry.allowed += 1;
    else entry.denied += 1;
    return entry;
  }
  function totalBytes(token) {
    const destinations = jobs.get(token);
    if (!destinations) return 0;
    let total = 0;
    for (const entry of destinations.values()) total += entry.bytesIn + entry.bytesOut;
    return total;
  }
  function snapshot(token) {
    const destinations = jobs.get(token);
    return {
      job: token,
      totalBytes: totalBytes(token),
      destinations: destinations
        ? Array.from(destinations.values()).map((entry) => ({ ...entry }))
        : [],
    };
  }
  return { record, totalBytes, snapshot };
}

function auditLine(fields) {
  process.stdout.write(JSON.stringify({ t: Date.now(), ...fields }) + "\n");
}

function createGateway(config) {
  const stats = createStats();
  const registry = createRegistry();

  function decide(token, host, port) {
    if (!token) return { allowed: false, code: 407, reason: "unattributed" };
    const policy = registry.get(token);
    if (!policy) return { allowed: false, code: 407, reason: "unregistered_token" };
    const listAllowed = hostAllowed(host, policy.mode, policy.allowlist);
    const quotaExceeded =
      policy.maxBytesPerJob > 0 && stats.totalBytes(token) >= policy.maxBytesPerJob;
    const allowed = listAllowed && !quotaExceeded;
    const entry = stats.record(token, host, port, allowed);
    if (!listAllowed) return { allowed: false, code: 403, reason: "denied_by_allowlist", entry };
    if (quotaExceeded) return { allowed: false, code: 403, reason: "byte_quota_exceeded", entry };
    return { allowed: true, entry, policy };
  }

  /** True once the job has crossed its byte cap (for in-transfer severing). */
  function overQuota(token, policy) {
    return policy.maxBytesPerJob > 0 && stats.totalBytes(token) >= policy.maxBytesPerJob;
  }

  const proxyServer = http.createServer(async (req, res) => {
    const token = jobTokenFrom(req.headers["proxy-authorization"]);
    let target;
    try {
      target = new URL(req.url);
    } catch {
      res.writeHead(400);
      res.end("bad request");
      return;
    }
    const port = Number(target.port || 80);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      res.writeHead(400);
      res.end("bad port");
      return;
    }
    const decision = decide(token, target.hostname, port);
    auditLine({ kind: "http", job: token, host: target.hostname, port, allowed: decision.allowed, reason: decision.reason });
    if (!decision.allowed) {
      res.writeHead(decision.code, decision.code === 407 ? { "Proxy-Authenticate": "Basic" } : {});
      res.end(decision.reason);
      return;
    }
    const pinned = await resolvePinnedAddress(target.hostname);
    if (!pinned) {
      res.writeHead(403);
      res.end("destination_blocked");
      return;
    }
    const headers = { ...req.headers, host: target.host };
    delete headers["proxy-authorization"];
    delete headers["proxy-connection"];
    const upstream = http.request(
      { host: pinned, port, method: req.method, path: target.pathname + target.search, headers },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
        upstreamRes.on("data", (chunk) => {
          decision.entry.bytesIn += chunk.length;
          if (overQuota(token, decision.policy)) upstream.destroy();
        });
        upstreamRes.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end("upstream error");
    });
    req.on("data", (chunk) => {
      decision.entry.bytesOut += chunk.length;
      if (overQuota(token, decision.policy)) upstream.destroy();
    });
    req.pipe(upstream);
  });

  proxyServer.on("connect", async (req, clientSocket, head) => {
    const token = jobTokenFrom(req.headers["proxy-authorization"]);
    const authority = String(req.url || "");
    // IPv6-safe authority parse: [::1]:443 or host:443.
    let host;
    let portRaw;
    const v6 = /^\[(.+)\]:(\d+)$/.exec(authority);
    if (v6) {
      host = v6[1];
      portRaw = v6[2];
    } else {
      const idx = authority.lastIndexOf(":");
      host = idx >= 0 ? authority.slice(0, idx) : authority;
      portRaw = idx >= 0 ? authority.slice(idx + 1) : "443";
    }
    const port = Number(portRaw);
    if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) {
      clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      clientSocket.end();
      return;
    }
    const decision = decide(token, host, port);
    auditLine({ kind: "connect", job: token, host, port, allowed: decision.allowed, reason: decision.reason });
    if (!decision.allowed) {
      const status = decision.code === 407 ? "407 Proxy Authentication Required" : "403 Forbidden";
      const extra = decision.code === 407 ? "Proxy-Authenticate: Basic\r\n" : "";
      clientSocket.write(`HTTP/1.1 ${status}\r\n${extra}\r\n`);
      clientSocket.end();
      return;
    }
    const pinned = await resolvePinnedAddress(host);
    if (!pinned) {
      clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      clientSocket.end();
      return;
    }
    const upstream = net.connect(port, pinned, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length > 0) {
        decision.entry.bytesOut += head.length;
        upstream.write(head);
      }
      clientSocket.on("data", (chunk) => {
        decision.entry.bytesOut += chunk.length;
        if (overQuota(token, decision.policy)) {
          upstream.destroy();
          clientSocket.destroy();
        }
      });
      upstream.on("data", (chunk) => {
        decision.entry.bytesIn += chunk.length;
        if (overQuota(token, decision.policy)) {
          upstream.destroy();
          clientSocket.destroy();
        }
      });
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });
    upstream.on("error", () => clientSocket.end());
    clientSocket.on("error", () => upstream.destroy());
  });

  function controlAuthorized(req) {
    if (!config.controlSecret) return false;
    return constantTimeEquals(req.headers["x-egress-control"], config.controlSecret);
  }

  const adminServer = http.createServer((req, res) => {
    const url = new URL(req.url, "http://control.invalid");
    if (url.pathname === "/__health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    // Every other admin op requires the control secret (a sandbox that reaches
    // this port over the internal network has no secret ⇒ 401).
    if (!controlAuthorized(req)) {
      res.writeHead(401);
      res.end("unauthorized");
      return;
    }
    if (url.pathname === "/__register" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        let parsed;
        try {
          parsed = JSON.parse(body || "{}");
        } catch {
          res.writeHead(400);
          res.end("bad json");
          return;
        }
        if (!parsed.token) {
          res.writeHead(400);
          res.end("missing token");
          return;
        }
        registry.register(parsed.token, parsed);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    if (url.pathname === "/__unregister" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body || "{}");
          if (parsed.token) registry.unregister(parsed.token);
        } catch {
          /* ignore */
        }
        res.writeHead(200);
        res.end();
      });
      return;
    }
    if (url.pathname === "/__stats") {
      const job = url.searchParams.get("job") || "";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(stats.snapshot(job)));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  return { proxyServer, adminServer, stats, registry, config };
}

module.exports = {
  createGateway,
  parseConfig,
  hostAllowed,
  jobTokenFrom,
  isProtectedAddress,
  ipv6ToBytes,
  resolvePinnedAddress,
};

if (require.main === module) {
  const config = parseConfig(process.env);
  if (!config.controlSecret) {
    process.stderr.write("FATAL: EGRESS_CONTROL_SECRET is required\n");
    process.exit(2);
  }
  const gateway = createGateway(config);
  gateway.proxyServer.listen(config.proxyPort, "0.0.0.0", () => {
    auditLine({ kind: "listen", role: "proxy", port: config.proxyPort });
  });
  // Admin binds to 0.0.0.0 so the host-published control port reaches it; the
  // control secret (not network reachability) is the authorization boundary.
  gateway.adminServer.listen(config.adminPort, "0.0.0.0", () => {
    auditLine({ kind: "listen", role: "admin", port: config.adminPort });
  });
}
