# @cinatra-ai/connectors

The `/connectors` surface: a server-rendered index grid that aggregates every
installed connector into one filterable, scope-aware view. It reads each
connector's connection status, applies actor visibility and scope filters, and
renders cards that link to each connector's setup page.

This package owns the grid and its wiring only. The actual connect/save logic
for each provider lives in its own dedicated connector package (OpenAI, Gemini,
Anthropic, Gmail, Google Calendar, Apollo, Apify, Nango, and others).

## Public API

- `ConnectorsPage` — async server component for the `/connectors` route; resolves
  per-connector readiness, actor scopes, and visibility, then builds the card set.
- `ConnectorsClient` — client grid with search, connected/available toggle, scope
  filter, and sort controls.
- `ConnectorCardData` — type describing a single connector card (slug, name,
  optional logo, connected state, label, and href).

## Usage

```tsx
import { ConnectorsPage } from "@cinatra-ai/connectors";

// Mounted by the /connectors route in the host app.
export default function Page(props) {
  return <ConnectorsPage {...props} />;
}
```

## Docs

See https://docs.cinatra.ai
