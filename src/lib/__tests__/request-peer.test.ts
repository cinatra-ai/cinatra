/**
 * The connecting socket's peer address, and the forwarded headers the CLIENT
 * actually sent — the two facts the development-only routes now decide on.
 *
 * The point of the suite is the difference between what a caller CLAIMS and
 * what the connection IS. Every "spoof" case below sends headers any remote
 * caller can send verbatim; the helper must answer from the socket instead.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

import {
  CLIENT_FORWARDED_HEADER,
  FORWARDED_HEADER_NAMES,
  NO_CLIENT_FORWARDED,
  SOCKET_PEER_HEADER,
  installSocketPeerStamp,
  isLoopbackPeerAddress,
  socketPeerVerdict,
} from "@/lib/request-peer";

/** A `Headers`-shaped bag, which is all the helper asks for. */
function bag(entries: Record<string, string>): Headers {
  return new Headers(entries);
}

describe("isLoopbackPeerAddress", () => {
  it("accepts the four shapes a loopback socket really reports", () => {
    expect(isLoopbackPeerAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackPeerAddress("::1")).toBe(true);
    expect(isLoopbackPeerAddress("[::1]")).toBe(true);
    // Node reports an IPv4 client on a dual-stack listener this way.
    expect(isLoopbackPeerAddress("::ffff:127.0.0.1")).toBe(true);
  });

  it("accepts the whole 127.0.0.0/8 loopback block, not just .0.1", () => {
    expect(isLoopbackPeerAddress("127.0.0.53")).toBe(true);
    expect(isLoopbackPeerAddress("127.1.2.3")).toBe(true);
  });

  it("refuses every address that is not on this machine", () => {
    // A reserved documentation address (RFC 5737) stands in for the remote
    // caller throughout this change, and an IPv6 one (RFC 3849) for its v6 twin.
    expect(isLoopbackPeerAddress("203.0.113.7")).toBe(false);
    expect(isLoopbackPeerAddress("2001:db8::1")).toBe(false);
    expect(isLoopbackPeerAddress("[2001:db8::1]")).toBe(false);
    // The address immediately after the loopback block: the 127 check is an
    // octet comparison, not a loose string prefix.
    expect(isLoopbackPeerAddress("128.0.0.1")).toBe(false);
    // The container-gateway name is a HOST, never a peer address, and it
    // resolves to an off-machine address from inside the container.
    expect(isLoopbackPeerAddress("host.docker.internal")).toBe(false);
    expect(isLoopbackPeerAddress("localhost")).toBe(false);
  });

  it("refuses unparseable, empty and padded junk — fail closed", () => {
    expect(isLoopbackPeerAddress("")).toBe(false);
    expect(isLoopbackPeerAddress("   ")).toBe(false);
    expect(isLoopbackPeerAddress("127.0.0.1 127.0.0.1")).toBe(false);
    expect(isLoopbackPeerAddress("127.0.0.1.evil.example")).toBe(false);
  });
});

describe("socketPeerVerdict", () => {
  it("passes a loopback peer that the client sent no forwarded header with", () => {
    const verdict = socketPeerVerdict(
      bag({
        [SOCKET_PEER_HEADER]: "127.0.0.1",
        [CLIENT_FORWARDED_HEADER]: NO_CLIENT_FORWARDED,
      }),
    );
    expect(verdict.ok).toBe(true);
  });

  it("refuses when the stamp is absent — an unstamped request proves nothing", () => {
    const verdict = socketPeerVerdict(bag({ host: "localhost:3000" }));
    expect(verdict).toEqual({ ok: false, reason: "socket-peer-not-stamped" });
  });

  it("refuses when the peer stamp is missing even though the forwarded stamp is there", () => {
    const verdict = socketPeerVerdict(
      bag({ [CLIENT_FORWARDED_HEADER]: NO_CLIENT_FORWARDED }),
    );
    expect(verdict).toEqual({ ok: false, reason: "socket-peer-not-stamped" });
  });

  it("refuses a non-loopback peer whatever the Host header claims", () => {
    const verdict = socketPeerVerdict(
      bag({
        host: "localhost:3000",
        [SOCKET_PEER_HEADER]: "203.0.113.7",
        [CLIENT_FORWARDED_HEADER]: NO_CLIENT_FORWARDED,
      }),
    );
    expect(verdict).toEqual({ ok: false, reason: "non-loopback-socket-peer" });
  });

  it.each(FORWARDED_HEADER_NAMES)(
    "refuses a loopback peer when the client sent %s",
    (name) => {
      const verdict = socketPeerVerdict(
        bag({
          [SOCKET_PEER_HEADER]: "127.0.0.1",
          [CLIENT_FORWARDED_HEADER]: name,
        }),
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.ok === false && verdict.reason).toBe(
        `client-forwarded-header:${name}`,
      );
    },
  );

  it.each(["x-forwarded-port", "x-forwarded-server"])(
    "refuses a loopback peer when the client sent %s — a name no list has to carry",
    (name) => {
      // Hardcoded ON PURPOSE, not taken from FORWARDED_HEADER_NAMES: a test
      // that iterates the production constant can only ever agree with it, so
      // it cannot notice a spelling the constant forgot. The policy is "ANY
      // forwarded header", and x-forwarded-port is one the framework itself
      // synthesises.
      const verdict = socketPeerVerdict(
        bag({
          [SOCKET_PEER_HEADER]: "127.0.0.1",
          [CLIENT_FORWARDED_HEADER]: name,
        }),
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.ok === false && verdict.reason).toBe(
        `client-forwarded-header:${name}`,
      );
    },
  );

  it("refuses a forwarded chain that names only loopback hops", () => {
    // Stricter than src/lib/test-support/lifecycle-seed-fence.ts's
    // forwardedChainIsLocal, which lets an all-loopback chain through. Here
    // the chain is a CLAIM and the socket is the fact, so the claim's presence
    // is itself the disqualifier.
    const verdict = socketPeerVerdict(
      bag({
        [SOCKET_PEER_HEADER]: "127.0.0.1",
        [CLIENT_FORWARDED_HEADER]: "x-forwarded-for",
      }),
    );
    expect(verdict.ok).toBe(false);
  });
});

describe("installSocketPeerStamp over a real HTTP server", () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    installSocketPeerStamp();
    server = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          peer: req.headers[SOCKET_PEER_HEADER] ?? null,
          forwarded: req.headers[CLIENT_FORWARDED_HEADER] ?? null,
        }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function probe(headers: Record<string, string>) {
    const response = await fetch(`http://127.0.0.1:${port}/`, { headers });
    return (await response.json()) as {
      peer: string | null;
      forwarded: string | null;
    };
  }

  it("stamps the real peer address on a plain request", async () => {
    const seen = await probe({});
    expect(isLoopbackPeerAddress(seen.peer ?? "")).toBe(true);
    expect(seen.forwarded).toBe(NO_CLIENT_FORWARDED);
  });

  it("OVERWRITES a client-supplied peer stamp — the header is not an input", async () => {
    const seen = await probe({ [SOCKET_PEER_HEADER]: "127.0.0.1" });
    // The forged value is gone: what arrives is the socket's own address, and
    // the request is still recognisably local because it really is.
    expect(isLoopbackPeerAddress(seen.peer ?? "")).toBe(true);
    const spoofedRemote = await probe({ [SOCKET_PEER_HEADER]: "2001:db8::1" });
    expect(spoofedRemote.peer).not.toBe("2001:db8::1");
  });

  it("OVERWRITES a client-supplied forwarded stamp", async () => {
    const seen = await probe({ [CLIENT_FORWARDED_HEADER]: NO_CLIENT_FORWARDED });
    expect(seen.forwarded).toBe(NO_CLIENT_FORWARDED);
  });

  it("records the forwarded headers the client really sent", async () => {
    const seen = await probe({
      "x-forwarded-for": "127.0.0.1",
      "x-forwarded-host": "localhost",
    });
    expect(seen.forwarded).toBe("x-forwarded-for,x-forwarded-host");
    expect(isLoopbackPeerAddress(seen.peer ?? "")).toBe(true);
  });

  it("records a bare Forwarded header too", async () => {
    const seen = await probe({ forwarded: 'for="127.0.0.1"' });
    expect(seen.forwarded).toBe("forwarded");
  });

  it("records x-forwarded-port, which no closed list of names carried", async () => {
    const seen = await probe({ "x-forwarded-port": "3000" });
    expect(seen.forwarded).toBe("x-forwarded-port");
  });

  it("records an x-forwarded-* spelling nobody listed", async () => {
    // The stamp reads the request's OWN header names, so a proxy header this
    // codebase has never heard of is still recorded — and therefore still
    // refused by the gate — rather than passing as "none".
    const seen = await probe({ "x-forwarded-server": "edge-1" });
    expect(seen.forwarded).toBe("x-forwarded-server");
  });

  it("is idempotent — a second install does not double-stamp", async () => {
    expect(installSocketPeerStamp()).toBe(false);
    const seen = await probe({ "x-forwarded-proto": "http" });
    expect(seen.forwarded).toBe("x-forwarded-proto");
  });
});
