## Broken and unterminated fences mid-stream

A paragraph before an unterminated code fence.

```ts
const x = 1;
// stream cut off before the closing fence — the renderer must not swallow
// the rest of the document or crash
