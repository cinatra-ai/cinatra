# assistant-mention-poll

## Purpose

Poll Cinatra's `chat_mentions_poll` MCP tool for pending @mentions directed at this assistant, respond via `chat_thread_send`, and loop.

## When to use

When a local Claude Code instance is running as the "@claude-code" assistant identity and should continuously watch the Cinatra chat for tasks assigned via @mention.

## Preconditions

- Cinatra dev server running on `http://localhost:3000`
- OAuth `client_id` + `client_secret` registered (see `/configuration/assistants` in the Cinatra admin UI)
- MCP access token obtained via client_credentials grant at `/api/auth/oauth/token`

## Obtaining a token

```
POST /api/auth/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
&client_id=<your client_id>
&client_secret=<your client_secret>
&scope=mcp:connect
```

Store the returned `access_token` and use it as a Bearer token on all subsequent MCP calls.

## Polling loop

1. Call `chat_mentions_poll` with `{ limit: 10, since: <last-seen-createdAt or omit on first run> }`
2. For each item in `result.items`:
   a. Read `content`, `threadId`, `messageId`
   b. Perform the requested work using any available MCP tools
   c. Call `chat_thread_send` with `{ threadId, message: <your reply> }` — this automatically marks the mention as handled
3. Record the maximum `createdAt` seen across all items as the new `since` value
4. Sleep 5 seconds
5. Go to step 1

## Stopping

Exit the loop when the user cancels (Ctrl+C) or when `chat_mentions_poll` returns an error.

## Error handling

- On 401/403: token expired — re-run the client_credentials grant to obtain a fresh token
- On network error: sleep 15 seconds and retry
- On malformed response: log the issue and continue to the next poll cycle

## Important constraints

- Do NOT poll faster than every 5 seconds
- Do NOT re-reply to the same `messageId` (maintain a local set of handled IDs as a safety net against duplicate processing)
- `chat_thread_send` from an assistant does NOT re-invoke the Cinatra LLM — it persists the message directly into the thread

## Notes

- `chat_mentions_poll` returns `{ items, total, hasMore }` — iterate `items`
- Each item has: `threadId`, `threadTitle`, `messageId`, `content`, `createdAt`, `mentions`
- Replying via `chat_thread_send` flips `mentionState[yourUserId]` from `"pending"` to `"handled"` automatically
- The `since` filter uses lexicographic ISO timestamp comparison — always pass the last seen `createdAt`
