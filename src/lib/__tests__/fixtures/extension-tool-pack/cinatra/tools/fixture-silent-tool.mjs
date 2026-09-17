// A FIXTURE pack's declared tool that files NO review target (cinatra#3249).
// Its result reaches the caller unchanged — the review-gate filing is a port a
// tool MAY reach, never a shape the host imposes on every result.

export function extensionTool({ input }) {
  return { ok: true, echoed: input };
}
