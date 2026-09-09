import { describe, expect, it } from "vitest";

// WAVE 3 OF `PLAN: Agents Lifecycle (D) — Review` (cinatra#3091, epic #3087) —
// THE CAPPED READ MUST STILL BE A PREFIX OF THE WORK.
//
// The content channel's whole promise to a display is that what it carries is
// the beginning of the pinned revision. A read that stops at a byte offset and
// then decodes can cut a character in half, and the decoder writes a
// replacement character where the half was — so the string is no longer a
// prefix of anything, and the channel's own careful truncation never sees the
// damage because it happened before the channel was called.

import {
  incompleteTrailingUtf8Bytes,
  readCappedUtf8,
} from "@/lib/artifacts/artifact-content-channel-ports";

async function* oneChunk(bytes: Buffer): AsyncGenerator<Uint8Array> {
  yield bytes;
}

describe("wave 3 — the capped read never invents a character", () => {
  it("counts the bytes of a sequence the buffer does not finish", () => {
    const euro = Buffer.from("€", "utf8"); // three bytes
    expect(incompleteTrailingUtf8Bytes(euro)).toBe(0);
    expect(incompleteTrailingUtf8Bytes(euro.subarray(0, 2))).toBe(2);
    expect(incompleteTrailingUtf8Bytes(euro.subarray(0, 1))).toBe(1);
    const emoji = Buffer.from("😀", "utf8"); // four bytes
    expect(incompleteTrailingUtf8Bytes(emoji)).toBe(0);
    expect(incompleteTrailingUtf8Bytes(emoji.subarray(0, 3))).toBe(3);
    expect(incompleteTrailingUtf8Bytes(Buffer.from("abc", "utf8"))).toBe(0);
    expect(incompleteTrailingUtf8Bytes(Buffer.alloc(0))).toBe(0);
  });

  it("drops an unfinished character rather than decoding it to a replacement", async () => {
    const full = Buffer.from("aé€😀z", "utf8");
    for (let cut = 1; cut <= full.length; cut += 1) {
      const text = await readCappedUtf8(oneChunk(full.subarray(0, cut)));
      expect(text, `cut at ${cut}`).not.toContain("�");
      // Whatever survives is a genuine prefix of the work.
      expect("aé€😀z".startsWith(text), `cut at ${cut}`).toBe(true);
    }
  });
});
