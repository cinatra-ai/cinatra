# @cinatra-ai/cli

The `cinatra` command-line tool for setting up, operating, and maintaining a Cinatra instance. It provisions auth, the workspace database schema, MCP server, and OAuth clients; manages isolated dev branches and deep-fork clones; runs backups; and handles agent and extension lifecycle tasks.

## Public API

The package is primarily a binary. The `cinatra` executable is its main entry point.

- `cinatra` (bin) — the CLI; run `cinatra --help` for the full command list.
- `runCli(argv)` — async entry point that parses arguments and dispatches a command.
- `parseRedisTarget(redisUrl)` — parse a Redis URL into connection target fields.

### Command groups

- `setup dev|prod|nango|branch|clone` — initialize auth, schema, MCP, and OAuth clients; provision isolated branches or clones.
- `teardown branch` — drop a branch's isolated schema and queue keys.
- `clone refresh-seed|start|stop|status|prune|list` — manage deep-fork clone databases and lifecycle.
- `dev refresh|tunnel` — reconcile local dependencies and dev schema; control the dev tunnel.
- `backup create|import|export-api-configs|import-api-configs` — back up and restore instance data and API configs.
- `agent export|import` and `agents install` — move agents in and out and install agent packages.
- `extensions purge|submit` — remove an extension everywhere or submit a built tarball for review.
- `status` — report the current instance configuration and health.

## Usage

```ts
import { runCli } from "@cinatra-ai/cli";

await runCli(["setup", "dev"]);
```

Or via the binary:

```bash
cinatra setup dev
cinatra --help
```

## Docs

See https://docs.cinatra.ai for full documentation.
