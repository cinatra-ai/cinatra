# @cinatra-ai/google-oauth-connection

Server-only runtime facade for Cinatra's Google OAuth connection. It reads and persists
the Google OAuth client settings, reports connection status, refreshes access tokens via
Nango, and provides an authenticated fetch helper for calling Google APIs (Gmail, Calendar,
YouTube, user info).

## Public API

- `getGoogleOAuthSettings()` — resolve client id/secret/redirect URI
- `saveGoogleOAuthSettings(input)` — persist settings and ensure the Nango integration
- `getGoogleOAuthStatus()` — instance-level connection status
- `getUserGoogleOAuthStatus(userId)` — per-user connection status
- `clearGoogleOAuthConnection()` — disconnect the instance connection
- `clearUserGoogleOAuthConnection(userId)` — disconnect a user's connection
- `refreshGoogleOAuthAccessTokenIfNeeded(input?)` — force-refresh and return tokens
- `googleApiFetch(input, options?)` — call a Google API endpoint with a bearer token

## Usage

```ts
import { googleApiFetch } from "@cinatra-ai/google-oauth-connection";

const profile = await googleApiFetch<{ emailAddress: string }>({
  url: "https://gmail.googleapis.com/gmail/v1/users/me/profile",
});
```

## Docs

See https://docs.cinatra.ai for full documentation.
