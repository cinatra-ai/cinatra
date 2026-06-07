// Hermetic regression tests for `parseRedisTarget` — the safety-critical
// redis-target parser feeding `clone prune`'s Redis cleanup. These cases lock
// the parser contract:
//
//  - explicit-but-unparseable REDIS_URL => parsed:false (caller fails closed,
//    NEVER silently assumes loopback:6379 → no wrong-Redis / false slot
//    release)
//  - ioredis protocol-less forms (`host:port`, bare host) are accepted
//  - IPv6 `[::1]` / `redis://[::1]` are recognised as loopback
//  - only 127.0.0.1 / localhost / ::1 are loopback (in-container fallback
//    is gated on `parsed && isLoopback`)

import { describe, it, expect } from "vitest";
import { parseRedisTarget } from "../src/index.mjs";

describe("parseRedisTarget", () => {
  it("no URL → redis-cli default loopback, parsed", () => {
    for (const v of [undefined, "", null]) {
      expect(parseRedisTarget(v)).toEqual({
        host: "127.0.0.1",
        port: 6379,
        isLoopback: true,
        parsed: true,
      });
    }
  });

  it("standard redis:// and rediss:// URLs", () => {
    expect(parseRedisTarget("redis://127.0.0.1:6379")).toMatchObject({
      host: "127.0.0.1",
      port: 6379,
      isLoopback: true,
      parsed: true,
    });
    expect(parseRedisTarget("rediss://localhost:6380")).toMatchObject({
      host: "localhost",
      port: 6380,
      isLoopback: true,
      parsed: true,
    });
    expect(parseRedisTarget("redis://user:pw@10.0.0.5:6379")).toMatchObject({
      host: "10.0.0.5",
      port: 6379,
      isLoopback: false,
      parsed: true,
    });
  });

  it("ioredis protocol-less host:port forms", () => {
    // Protocol-less forms must parse explicitly instead of falling through to
    // loopback:6379, which would risk a wrong-Redis / false-slot-release path.
    expect(parseRedisTarget("127.0.0.1:6380")).toMatchObject({
      host: "127.0.0.1",
      port: 6380,
      isLoopback: true,
      parsed: true,
    });
    expect(parseRedisTarget("localhost:6380")).toMatchObject({
      host: "localhost",
      port: 6380,
      isLoopback: true,
      parsed: true,
    });
    expect(parseRedisTarget("cache.example.com:6380")).toMatchObject({
      host: "cache.example.com",
      port: 6380,
      isLoopback: false,
      parsed: true,
    });
    expect(parseRedisTarget("myredis")).toMatchObject({
      host: "myredis",
      isLoopback: false,
      parsed: true,
    });
  });

  it("IPv6 loopback is unbracketed and recognised", () => {
    expect(parseRedisTarget("[::1]:6379")).toMatchObject({
      host: "::1",
      port: 6379,
      isLoopback: true,
      parsed: true,
    });
    expect(parseRedisTarget("redis://[::1]:6379")).toMatchObject({
      host: "::1",
      isLoopback: true,
      parsed: true,
    });
  });

  it("explicit-but-unparseable REDIS_URL fails closed", () => {
    const res = parseRedisTarget("::::garbage:::");
    expect(res.parsed).toBe(false);
    expect(res.isLoopback).toBe(false);
    // The caller (resolveRedisCliRunner) refuses the in-container runner
    // unless `parsed && isLoopback`, so this retains the slot rather than
    // cleaning an arbitrary local Redis.
  });

  it("only 127.0.0.1 / localhost / ::1 are loopback", () => {
    for (const remote of [
      "redis://10.0.0.5:6379",
      "redis://redis.internal:6379",
      "192.168.1.10:6379",
    ]) {
      expect(parseRedisTarget(remote).isLoopback).toBe(false);
    }
  });
});
