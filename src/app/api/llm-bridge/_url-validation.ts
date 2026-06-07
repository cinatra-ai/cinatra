import { isIP } from "node:net";

export const BRIDGE_URL_ERROR_CODES = [
  "BRIDGE-URL-INVALID",
  "BRIDGE-URL-SCHEME-NOT-ALLOWED",
  "BRIDGE-URL-HOST-BLOCKED",
  "BRIDGE-URL-REDIRECT-BLOCKED",
  "BRIDGE-URL-REDIRECT-LIMIT",
] as const;

export type BridgeUrlErrorCode = (typeof BRIDGE_URL_ERROR_CODES)[number];

export class BridgeUrlError extends Error {
  readonly code: BridgeUrlErrorCode;
  constructor(code: BridgeUrlErrorCode, message: string) {
    super(message);
    this.name = "BridgeUrlError";
    this.code = code;
  }
}

const BIG_ZERO = BigInt(0);
const BIG_ONE = BigInt(1);
const BIG_8 = BigInt(8);
const BIG_16 = BigInt(16);
const BIG_24 = BigInt(24);
const BIG_32 = BigInt(32);
const BIG_80 = BigInt(80);
const BIG_112 = BigInt(112);
const BIG_128 = BigInt(128);
const HEX_FFFF = BigInt(0xffff);
const HEX_FFFFFFFF = BigInt(0xffffffff);

const BLOCKED_IPV4_CIDRS = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
];

const BLOCKED_IPV6_CIDRS = [
  "::/128",
  "::1/128",
  "::ffff:0:0/96",
  "100::/64",
  "2001::/23",
  "2001:db8::/32",
  "2002::/16",
  "fc00::/7",
  "fe80::/10",
  "ff00::/8",
  "64:ff9b::/96",
  "64:ff9b:1::/48",
];

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata.aws",
  "metadata.azure.com",
]);

const ALLOWED_SCHEME = "https:";

type ParsedCidr = { addr: bigint; bits: number; family: 4 | 6 };

function ipToBigInt(ip: string, family: 4 | 6): bigint {
  if (family === 4) {
    const parts = ip.split(".").map((p) => Number(p));
    if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
      throw new Error(`invalid IPv4 literal: ${ip}`);
    }
    return (
      (BigInt(parts[0]) << BIG_24) |
      (BigInt(parts[1]) << BIG_16) |
      (BigInt(parts[2]) << BIG_8) |
      BigInt(parts[3])
    );
  }
  const expanded = expandIpv6(ip);
  const groups = expanded.split(":");
  if (groups.length !== 8) {
    throw new Error(`invalid IPv6 literal after expansion: ${ip}`);
  }
  let result = BIG_ZERO;
  for (const g of groups) {
    const value = parseInt(g, 16);
    if (Number.isNaN(value) || value < 0 || value > 0xffff) {
      throw new Error(`invalid IPv6 group "${g}" in ${ip}`);
    }
    result = (result << BIG_16) | BigInt(value);
  }
  return result;
}

function expandIpv6(ip: string): string {
  let working = ip;
  const lastColon = working.lastIndexOf(":");
  const tail = working.slice(lastColon + 1);
  if (tail.includes(".")) {
    const parts = tail.split(".").map((p) => Number(p));
    if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
      throw new Error(`invalid IPv4-tail in IPv6 ${ip}`);
    }
    const hex = `${parts[0].toString(16).padStart(2, "0")}${parts[1]
      .toString(16)
      .padStart(2, "0")}:${parts[2].toString(16).padStart(2, "0")}${parts[3]
      .toString(16)
      .padStart(2, "0")}`;
    working = working.slice(0, lastColon + 1) + hex;
  }
  if (working.includes("::")) {
    const [left, right] = working.split("::");
    const leftGroups = left ? left.split(":") : [];
    const rightGroups = right ? right.split(":") : [];
    const missing = 8 - leftGroups.length - rightGroups.length;
    if (missing < 0) {
      throw new Error(`invalid IPv6 expansion: ${ip}`);
    }
    const middle = new Array<string>(missing).fill("0");
    working = [...leftGroups, ...middle, ...rightGroups].join(":");
  }
  return working;
}

function parseCidr(cidr: string): ParsedCidr {
  const slash = cidr.indexOf("/");
  if (slash === -1) throw new Error(`missing /bits in CIDR: ${cidr}`);
  const addrStr = cidr.slice(0, slash);
  const bits = Number(cidr.slice(slash + 1));
  const family = isIP(addrStr);
  if (family !== 4 && family !== 6) {
    throw new Error(`invalid CIDR address: ${cidr}`);
  }
  const totalBits = family === 4 ? 32 : 128;
  if (!Number.isInteger(bits) || bits < 0 || bits > totalBits) {
    throw new Error(`invalid CIDR bits: ${cidr}`);
  }
  return { addr: ipToBigInt(addrStr, family as 4 | 6), bits, family: family as 4 | 6 };
}

function isInCidr(addr: bigint, cidr: ParsedCidr): boolean {
  const totalBits = cidr.family === 4 ? 32 : 128;
  if (cidr.bits === 0) return true;
  const hostBits = BigInt(totalBits - cidr.bits);
  const totalMask = (BIG_ONE << BigInt(totalBits)) - BIG_ONE;
  const mask = totalMask ^ ((BIG_ONE << hostBits) - BIG_ONE);
  return (addr & mask) === (cidr.addr & mask);
}

const PARSED_IPV4_CIDRS = BLOCKED_IPV4_CIDRS.map(parseCidr);
const PARSED_IPV6_CIDRS = BLOCKED_IPV6_CIDRS.map(parseCidr);

const FULL_128_MASK = (BIG_ONE << BIG_128) - BIG_ONE;
const FULL_32_MASK = (BIG_ONE << BIG_32) - BIG_ONE;
const FULL_112_MASK = (BIG_ONE << BIG_112) - BIG_ONE;
const IPV6_TOP_96_MASK = FULL_128_MASK ^ FULL_32_MASK;
const IPV6_TOP_16_MASK = FULL_128_MASK ^ FULL_112_MASK;
const IPV6_IPV4_MAPPED_PREFIX = HEX_FFFF << BIG_32;
const IPV6_6TO4_PREFIX = BigInt(0x2002) << BIG_112;

export function validateAddress(addressStr: string, family: 4 | 6): boolean {
  if (family === 4) {
    const addr = ipToBigInt(addressStr, 4);
    return !PARSED_IPV4_CIDRS.some((c) => isInCidr(addr, c));
  }
  const addr = ipToBigInt(addressStr, 6);
  if ((addr & IPV6_TOP_96_MASK) === IPV6_IPV4_MAPPED_PREFIX) {
    const ipv4Bits = addr & HEX_FFFFFFFF;
    return !PARSED_IPV4_CIDRS.some((c) => isInCidr(ipv4Bits, c));
  }
  if ((addr & IPV6_TOP_16_MASK) === IPV6_6TO4_PREFIX) {
    const ipv4Bits = (addr >> BIG_80) & HEX_FFFFFFFF;
    if (PARSED_IPV4_CIDRS.some((c) => isInCidr(ipv4Bits, c))) return false;
  }
  return !PARSED_IPV6_CIDRS.some((c) => isInCidr(addr, c));
}

export function stripBrackets(host: string): string {
  if (host.length >= 2 && host.startsWith("[") && host.endsWith("]")) {
    return host.slice(1, -1);
  }
  return host;
}

export function validateExternalUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new BridgeUrlError(
      "BRIDGE-URL-INVALID",
      `cannot parse URL`,
    );
  }
  if (parsed.protocol !== ALLOWED_SCHEME) {
    throw new BridgeUrlError(
      "BRIDGE-URL-SCHEME-NOT-ALLOWED",
      `scheme ${parsed.protocol} not allowed (only https:)`,
    );
  }
  const host = stripBrackets(parsed.hostname);
  const lowerHost = host.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(lowerHost)) {
    throw new BridgeUrlError(
      "BRIDGE-URL-HOST-BLOCKED",
      `hostname ${host} is blocked`,
    );
  }
  const literalFamily = isIP(host);
  if (literalFamily === 4 || literalFamily === 6) {
    if (!validateAddress(host, literalFamily as 4 | 6)) {
      throw new BridgeUrlError(
        "BRIDGE-URL-HOST-BLOCKED",
        `IP literal ${host} in a blocked range`,
      );
    }
  }
  return parsed;
}

// Mirrors the production YOUTUBE_HOSTNAMES set in _llm-dispatch.ts so the
// strict helper here is a drop-in replacement at the bridge call site.
// Includes `youtube-nocookie.com` (privacy-enhanced embed domain) — both
// the `www.` and bare forms are routinely emitted by YouTube and remain
// legitimate.
export const YOUTUBE_HOST_ALLOWLIST = new Set([
  "youtube.com",
  "www.youtube.com",
  "youtu.be",
  "m.youtube.com",
  "music.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);

export function isYouTubeUrlStrict(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    return YOUTUBE_HOST_ALLOWLIST.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}
