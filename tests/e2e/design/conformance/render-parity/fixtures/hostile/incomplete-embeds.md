## Incomplete embeds mid-stream (trimming, not crashing)

An incomplete display-math block, cut off before the closing delimiter:

$$\int_0^1 x^2

An incomplete mermaid fence, streamed partway:

```mermaid
graph TD;
  A-->B;

An incomplete chart embed, truncated mid-JSON:

[chart:{"version":1,"type":"bar","title":"Rev

A trailing paragraph the renderer must still show.
