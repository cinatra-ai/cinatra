# Authoring an inbound webhook (`cinatra.webhooks`)

Inbound webhooks are **extension-authored**. There is no built-in form to register
one from the `/webhooks` UI — that page only *lists* the hooks declared by the
extensions you have installed. A hook appears there once an installed extension
declares it and the generated registry is regenerated.

A connector OPTS IN to receiving webhooks by declaring `cinatra.webhooks` in its
`package.json` and shipping a handler module that exports the named `factory`. The
manifest generator collects every declaration **fail-closed** into the generated
registry; the host owns the public route, the per-binding secret store, and the
idempotency ledger. The host never imports a connector package and never branches
on vendor/slug — it dispatches through the generated registry.

## 1. Declare the hook in `package.json`

Add a `cinatra.webhooks.hooks` array. Each hook entry:

| Field          | Required | Meaning                                                                       |
| -------------- | -------- | ----------------------------------------------------------------------------- |
| `id`           | yes      | kebab-case hook id; becomes the `<hook>` URL segment                          |
| `handler`      | yes      | package-relative subpath to the handler module (e.g. `"./src/webhooks/post"`) |
| `factory`      | yes      | the named export the host invokes (a function)                                |
| `label`        | no       | human label shown in the `/webhooks` registry UI                              |
| `rejectStatus` | no       | a 4xx (400-499) the route returns for a `rejected` outcome (default 204)      |

```json
{
  "name": "@your-scope/your-connector",
  "cinatra": {
    "webhooks": {
      "hooks": [
        {
          "id": "post-published",
          "handler": "./src/webhooks/post-published",
          "factory": "createPostPublishedHandler",
          "label": "Post published"
        }
      ]
    }
  }
}
```

The host serves the hook at `/webhook/<vendor>/<slug>/<hook>/<bindingId>`, where
`<vendor>/<slug>` come from the package's npm scope/name and `<bindingId>` is a
server-issued opaque id (it carries the secret + connected-site identity — never
the payload).

## 2. Ship the handler `factory`

The handler module must export the named `factory` as a callable function. The
factory returns a `WebhookHandler` — the per-hook business logic that turns a
**verified** payload into a `WebhookHandlerOutcome`. The host verifies the
signature and resolves identity *before* calling you; re-validate the payload with
your own schema (the verify step authenticates the bytes, it does not shape the
payload).

```ts
import type {
  WebhookHandler,
  WebhookHandlerFactory,
} from "@cinatra-ai/webhooks";

export const createPostPublishedHandler: WebhookHandlerFactory = (): WebhookHandler => {
  return async (ctx) => {
    const { webhook, log } = ctx;
    // `webhook.siteId` is host-derived from the binding (NOT the payload).
    const parsed = MyPayloadSchema.safeParse(webhook.payload);
    if (!parsed.success) {
      // Authentic but unprocessable for us → not retried.
      return { outcome: "rejected", detail: { reason: "schema" } };
    }
    log("post published", { siteId: webhook.siteId });
    return { outcome: "accepted" };
  };
};
```

### Outcomes

| Outcome     | Meaning                                              | Ledger | HTTP                          |
| ----------- | --------------------------------------------------- | ------ | ----------------------------- |
| `accepted`  | processed                                           | done   | 200                           |
| `ignored`   | intentionally not actioned, not an error            | done   | 200                           |
| `retryable` | transient failure; sender SHOULD retry              | failed | 503                           |
| `rejected`  | authentic but semantically refused                  | done   | 204 (or declared `rejectStatus`) |

## 3. Install + regenerate

A declared hook is inert until its connector is installed and the registry is
regenerated (`node scripts/extensions/generate-extension-manifest.mjs`). After
that, the hook shows up in `/webhooks` and the route is live.

## Related

- [Outbound webhook delivery](./outbound-delivery.md) — how Cinatra *sends* signed
  webhooks (the Standard-Webhooks signature convention receivers verify).
- The public type surface (`VerifiedWebhook`, `WebhookContext`,
  `WebhookHandlerOutcome`, `WebhookHandlerFactory`) lives in
  `@cinatra-ai/webhooks` (`packages/webhooks/src/types.ts`).
