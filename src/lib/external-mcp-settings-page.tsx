import "server-only";
import { ConnectorSettingsDialog } from "@/components/connector-settings-dialog";
import { Button } from "@/components/ui/button";
import { LinkIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { FieldGroup, Field, FieldLabel } from "@/components/ui/field";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  listExternalMcpServers,
  type ExternalMcpServerRecord,
} from "@/lib/external-mcp-registry";
import { isPrivateUrl } from "@/lib/wordpress-mcp-connection";
import { requireAuthSession } from "@/lib/auth-session";
import { getNangoStatus } from "@/lib/nango-system";
import {
  createExternalMcpServerAction,
  deleteExternalMcpServerAction,
} from "@/app/campaigns/actions";

type SearchParams = Record<string, string | string[] | undefined>;

function pickParam(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function isAdminFromRole(role: unknown): boolean {
  return String(role ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
    .includes("admin");
}

export async function ExternalMcpSettingsPage(props?: {
  searchParams?: Promise<SearchParams>;
}) {
  const session = await requireAuthSession();
  const isAdmin = isAdminFromRole(session.user.role);
  const userId = session.user.id;

  const all = listExternalMcpServers();

  // Visibility: admins see everything; non-admins see only their own user-scoped rows.
  const visible: ExternalMcpServerRecord[] = isAdmin
    ? all
    : all.filter((row) => row.scope === "user" && row.userId === userId);

  const resolvedSearchParams = (await props?.searchParams) ?? {};
  const saved = pickParam(resolvedSearchParams.saved);
  const deleted = pickParam(resolvedSearchParams.deleted);
  const errorMessage = pickParam(resolvedSearchParams.error);

  const connectionServiceReady = getNangoStatus().status === "connected";

  return (
    <ConnectorSettingsDialog closeHref="/configuration/llm">
      <div className="flex flex-col gap-6">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.25em] text-muted-foreground">
            MCP registry
          </p>
          <h2 className="text-2xl font-semibold tracking-tight text-foreground">
            External MCP Servers
          </h2>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
            Register external Model Context Protocol servers so every Cinatra agent
            and package can call their tools. Admins can register globally; regular
            users can register personal servers visible only to them.
          </p>
        </div>

        {saved ? (
          <div className="rounded-control border border-success/30 bg-success/10 px-4 py-3 text-sm text-success">
            External MCP server saved.
          </div>
        ) : null}
        {deleted ? (
          <div className="rounded-control border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
            External MCP server removed.
          </div>
        ) : null}
        {errorMessage ? (
          <div className="rounded-control border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {errorMessage}
          </div>
        ) : null}

        <section className="soft-panel rounded-panel p-5">
          <h3 className="text-lg font-semibold text-foreground">Registered servers</h3>
          <div className="mt-4 grid gap-3">
            {visible.length === 0 ? (
              <p className="rounded-panel border border-dashed border-line bg-surface-muted px-5 py-5 text-sm text-muted-foreground">
                No external MCP servers registered yet.
              </p>
            ) : (
              visible.map((row) => (
                <article
                  key={row.id}
                  className="rounded-panel border border-line bg-surface px-5 py-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h4 className="text-base font-semibold text-foreground">
                          {row.label}
                        </h4>
                        <Badge variant="outline" className="uppercase">
                          {row.scope}
                        </Badge>
                        {isPrivateUrl(row.serverUrl) ? (
                          <Badge variant="destructive">Private URL — not injected</Badge>
                        ) : null}
                        {!row.enabled ? <Badge variant="secondary">Disabled</Badge> : null}
                      </div>
                      <p className="mt-2 truncate text-sm text-muted-foreground">
                        {row.serverUrl}
                      </p>
                      {row.nangoConnectionId ? (
                        <p className="mt-1 text-xs text-muted-foreground">API key configured</p>
                      ) : null}
                    </div>
                    <form action={deleteExternalMcpServerAction}>
                      <input type="hidden" name="id" value={row.id} />
                      <Button type="submit" variant="destructive" size="sm">
                        Delete
                      </Button>
                    </form>
                  </div>
                </article>
              ))
            )}
          </div>
        </section>

        <section className="soft-panel rounded-panel p-5">
          <h3 className="text-lg font-semibold text-foreground">Add a new server</h3>
          <form action={createExternalMcpServerAction} className="mt-4 grid gap-4">
            <FieldGroup>
              <Field>
                <FieldLabel>Label</FieldLabel>
                <Input
                  name="label"
                  placeholder="My MCP Server"
                  required
                  maxLength={120}
                />
              </Field>
              <Field>
                <FieldLabel>Server URL</FieldLabel>
                <InputGroup>
                  <InputGroupAddon>
                    <LinkIcon aria-hidden="true" />
                  </InputGroupAddon>
                  <InputGroupInput
                    name="serverUrl"
                    type="url"
                    placeholder="https://mcp.example.com/sse"
                    required
                  />
                </InputGroup>
                <p className="text-xs text-muted-foreground">
                  Must be a public URL — LLM providers cannot reach localhost or private IPs.
                </p>
              </Field>
              <Field>
                <FieldLabel>API key (optional)</FieldLabel>
                <Input
                  name="apiKey"
                  type="password"
                  placeholder="Leave blank if no authentication required"
                  autoComplete="off"
                />
                {connectionServiceReady ? (
                  <p className="text-xs text-muted-foreground">
                    The key is stored securely via the connection service.
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Configure the connection service to enable API key storage.
                  </p>
                )}
              </Field>
              <Field>
                <FieldLabel>Scope</FieldLabel>
                <Select name="scope" defaultValue={isAdmin ? "global" : "user"}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                <SelectContent>
                  {isAdmin ? (
                    <SelectItem value="global">Global (all users, all agents)</SelectItem>
                  ) : null}
                  {isAdmin ? (
                    <SelectItem value="org">Organization</SelectItem>
                  ) : null}
                  {isAdmin ? (
                    <SelectItem value="team">Team</SelectItem>
                  ) : null}
                  <SelectItem value="user">Personal (only me)</SelectItem>
                </SelectContent>
              </Select>
              {!isAdmin ? (
                <p className="text-xs text-muted-foreground">
                  Only admins can create global, org, or team-scoped servers.
                </p>
              ) : null}
              </Field>
            </FieldGroup>
            <div className="flex justify-end">
              <Button type="submit">Add server</Button>
            </div>
          </form>
        </section>
      </div>
    </ConnectorSettingsDialog>
  );
}
