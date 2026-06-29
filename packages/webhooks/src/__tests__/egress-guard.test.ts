import { describe, it, expect } from "vitest";
import {
  assertEgressAllowed,
  classifyIpLiteral,
  isEgressBlock,
  EgressBlockedError,
} from "../egress-guard";

// A lookup that resolves any name to ONE caller-chosen address (DNS-guard tests).
const lookupTo = (address: string, family = 4) => async () => [{ address, family }];

async function expectBlocked(url: string, opts?: { lookup?: () => Promise<readonly { address: string; family: number }[]> }) {
  await expect(assertEgressAllowed(url, opts)).rejects.toBeInstanceOf(EgressBlockedError);
}

describe("classifyIpLiteral — IPv4 ranges", () => {
  it.each([
    ["0.0.0.0", "this-network"],
    ["10.0.0.1", "rfc1918"],
    ["10.255.255.255", "rfc1918"],
    ["100.64.0.1", "cgnat"],
    ["127.0.0.1", "loopback"],
    ["127.1.2.3", "loopback"],
    ["169.254.169.254", "link-local"], // cloud metadata
    ["169.254.0.1", "link-local"],
    ["172.16.0.1", "rfc1918"],
    ["172.31.255.255", "rfc1918"],
    ["192.168.0.1", "rfc1918"],
    ["192.0.2.1", "documentation"],
    ["198.18.0.1", "benchmarking"],
    ["198.51.100.1", "documentation"],
    ["203.0.113.1", "documentation"],
    ["224.0.0.1", "multicast"],
    ["240.0.0.1", "reserved"],
    ["255.255.255.255", "broadcast"],
  ])("denies %s (%s)", (ip) => {
    expect(classifyIpLiteral(ip)).not.toBeNull();
  });

  it.each(["8.8.8.8", "93.184.216.34", "1.1.1.1", "172.15.255.255", "172.32.0.1", "11.0.0.1"])(
    "allows public %s",
    (ip) => {
      expect(classifyIpLiteral(ip)).toBeNull();
    },
  );
});

describe("classifyIpLiteral — IPv6 ranges", () => {
  it.each([
    ["::", "unspecified"],
    ["::1", "loopback"],
    ["fc00::1", "ula"],
    ["fdff:ffff::1", "ula"],
    ["fe80::1", "link-local"],
    ["febf::1", "link-local"],
    ["ff02::1", "multicast"],
    ["2001:db8::1", "documentation"],
    ["2002:0a00:0001::", "6to4"],
    ["::ffff:127.0.0.1", "loopback via mapped"],
    ["::ffff:10.0.0.1", "rfc1918 via mapped"],
    ["::ffff:169.254.169.254", "metadata via mapped"],
    ["64:ff9b::127.0.0.1", "loopback via nat64-wellknown"],
    ["64:ff9b:1::a9fe:a9fe", "nat64-local /48 (denied outright)"],
    ["64:ff9b:1::8.8.8.8", "nat64-local /48 — denied regardless of embedded v4"],
    ["::7f00:1", "loopback via compat"],
    ["::ffff:0:127.0.0.1", "loopback via ipv4-translated ::ffff:0:0/96"],
    ["::ffff:0:10.0.0.1", "rfc1918 via ipv4-translated"],
    ["::ffff:0:169.254.169.254", "metadata via ipv4-translated"],
    ["2001::1", "teredo / ietf-protocol 2001::/23"],
    ["2001:20::1", "orchidv2 / ietf-protocol 2001::/23"],
  ])("denies %s (%s)", (ip) => {
    expect(classifyIpLiteral(ip)).not.toBeNull();
  });

  it.each(["2606:4700:4700::1111", "::ffff:8.8.8.8", "64:ff9b::8.8.8.8", "2400:cb00::1", "::ffff:0:8.8.8.8"])(
    "allows public %s",
    (ip) => {
      expect(classifyIpLiteral(ip)).toBeNull();
    },
  );
});

describe("assertEgressAllowed — scheme / credentials / aliases", () => {
  it.each(["ftp://example.test/x", "file:///etc/passwd", "gopher://example.test/", "data:text/plain,hi"])(
    "blocks scheme %s",
    async (url) => {
      await expectBlocked(url, { lookup: lookupTo("93.184.216.34") });
    },
  );

  it("blocks embedded credentials", async () => {
    // Built from parts so the literal userinfo@host never appears in source
    // (avoids a secret-scanner basic-auth-URI false positive).
    const url = `https://${"u"}:${"p"}@example.test/x`;
    await expectBlocked(url, { lookup: lookupTo("93.184.216.34") });
  });

  it.each(["http://localhost/x", "http://LOCALHOST/x", "http://foo.localhost/x", "http://metadata/x", "http://metadata.google.internal/x"])(
    "blocks internal alias %s (no DNS)",
    async (url) => {
      // No lookup provided — alias must be rejected BEFORE any DNS resolution.
      await expectBlocked(url);
    },
  );

  it("blocks an unparseable URL", async () => {
    await expectBlocked("http://[not-an-ip");
  });
});

describe("assertEgressAllowed — literal IP hosts (no DNS)", () => {
  it.each([
    "http://127.0.0.1/x",
    "http://169.254.169.254/latest/",
    "http://10.0.0.1/x",
    "http://192.168.1.1/x",
    "http://[::1]/x",
    "http://[fc00::1]/x",
    "http://[fe80::1]/x",
    "http://[::ffff:127.0.0.1]/x",
  ])("blocks %s", async (url) => {
    await expectBlocked(url);
  });

  it.each(["http://8.8.8.8/x", "https://93.184.216.34/x", "http://[2606:4700:4700::1111]/x"])(
    "allows public literal %s",
    async (url) => {
      const addrs = await assertEgressAllowed(url);
      expect(addrs.length).toBeGreaterThan(0);
    },
  );

  it("normalizes legacy IPv4 forms via the URL parser (contract check)", async () => {
    // new URL normalizes http://2130706433/ and http://127.1/ to 127.0.0.1.
    for (const url of ["http://2130706433/x", "http://127.1/x", "http://0x7f.1/x", "http://0177.0.0.1/x"]) {
      const u = new URL(url);
      // If the platform normalizes to a literal IP, the guard must catch it.
      const { isIP } = await import("node:net");
      if (isIP(u.hostname.replace(/^\[|\]$/g, "")) !== 0) {
        await expectBlocked(url);
      }
    }
  });
});

describe("assertEgressAllowed — DNS guard", () => {
  it("blocks when the name resolves to an internal address", async () => {
    await expectBlocked("https://sneaky.test/x", { lookup: lookupTo("169.254.169.254") });
  });

  it("blocks when ANY of several answers is internal", async () => {
    await expect(
      assertEgressAllowed("https://multi.test/x", {
        lookup: async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "10.1.2.3", family: 4 },
        ],
      }),
    ).rejects.toBeInstanceOf(EgressBlockedError);
  });

  it("blocks empty resolution (fail closed)", async () => {
    await expect(
      assertEgressAllowed("https://void.test/x", { lookup: async () => [] }),
    ).rejects.toBeInstanceOf(EgressBlockedError);
  });

  it("allows when all answers are public", async () => {
    const addrs = await assertEgressAllowed("https://ok.test/x", {
      lookup: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "2606:4700:4700::1111", family: 6 },
      ],
    });
    expect(addrs.length).toBe(2);
  });

  it("propagates a real resolver error WITHOUT tagging it as an egress block", async () => {
    const resolverErr = Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    await expect(
      assertEgressAllowed("https://nope.test/x", {
        lookup: async () => {
          throw resolverErr;
        },
      }),
    ).rejects.toBe(resolverErr);
  });
});

describe("isEgressBlock — cause-chain detection", () => {
  it("detects a direct EgressBlockedError", () => {
    expect(isEgressBlock(new EgressBlockedError("x"))).toBe(true);
  });

  it("detects an EgressBlockedError nested on err.cause", () => {
    const wrapped = new TypeError("fetch failed", { cause: new EgressBlockedError("deep") });
    expect(isEgressBlock(wrapped)).toBe(true);
  });

  it("detects via the stable code even without the symbol", () => {
    expect(isEgressBlock({ code: "CINATRA_EGRESS_BLOCKED" })).toBe(true);
  });

  it("returns false for an ordinary network error", () => {
    expect(isEgressBlock(new Error("ECONNRESET"))).toBe(false);
    expect(isEgressBlock(new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") }))).toBe(false);
  });
});
