import { readConnectorConfigFromDatabase, writeConnectorConfigToDatabase } from "@/lib/database";
import {
  CINATRA_NANGO_PROVIDER_CONFIG_KEYS,
  ensureNangoIntegration,
  getNangoConnection,
  getNangoOAuth2IntegrationCredentials,
  getNangoOAuthCallbackUrl,
  getPrimarySavedNangoConnection,
  isNangoConfigured,
  listSavedNangoConnections,
  type SavedNangoConnection,
} from "@/lib/nango-system";

type GitHubStoredSettings = {
  redirectUri?: string;
  selectedRepositoryFullName?: string;
  selectedRepositoryUrl?: string;
  personalAccessToken?: string;
};

export type GitHubOAuthSettings = {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  scopes: string[];
  selectedRepositoryFullName?: string;
  selectedRepositoryUrl?: string;
  personalAccessToken?: string;
};

export type GitHubConnectionStatus = {
  status: "connected" | "incomplete" | "not_connected";
  detail?: string;
  accountName?: string;
  accountEmail?: string;
  settingsConfigured: boolean;
  selectedRepositoryFullName?: string;
  selectedRepositoryUrl?: string;
};

export type GitHubRepositoryOption = {
  id: number;
  owner: string;
  repo: string;
  fullName: string;
  url: string;
  visibility: "private" | "public";
  permissions: {
    admin: boolean;
    maintain: boolean;
    push: boolean;
    triage: boolean;
    pull: boolean;
  };
};

const GITHUB_OAUTH_SCOPES = ["repo", "workflow", "read:user", "user:email"] as const;
const GITHUB_OAUTH_SCOPES_VALUE = GITHUB_OAUTH_SCOPES.join(",");
const GITHUB_SETTINGS_CONNECTOR_ID = "github_oauth";

function readStoredSettings(): GitHubStoredSettings {
  return readConnectorConfigFromDatabase<GitHubStoredSettings>(GITHUB_SETTINGS_CONNECTOR_ID, {});
}

function writeStoredSettings(value: GitHubStoredSettings) {
  writeConnectorConfigToDatabase(GITHUB_SETTINGS_CONNECTOR_ID, value);
}

function parseSelectedRepository(value: string | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  const [owner, repo] = trimmed.split("/");
  if (!owner || !repo) {
    return undefined;
  }

  return {
    owner,
    repo,
    fullName: `${owner}/${repo}`,
  };
}

function resolveSavedGitHubConnection(connectionId?: string): SavedNangoConnection | null {
  if (!connectionId) {
    return getPrimarySavedNangoConnection("github");
  }

  return listSavedNangoConnections("github").find((connection) => connection.connectionId === connectionId) ?? null;
}

export async function getGitHubOAuthSettings(): Promise<GitHubOAuthSettings> {
  const nangoCredentials = await getNangoOAuth2IntegrationCredentials(CINATRA_NANGO_PROVIDER_CONFIG_KEYS.github);
  const stored = readStoredSettings();

  return {
    clientId: nangoCredentials?.clientId,
    clientSecret: nangoCredentials?.clientSecret,
    redirectUri: stored.redirectUri ?? getNangoOAuthCallbackUrl(),
    scopes: [...GITHUB_OAUTH_SCOPES],
    selectedRepositoryFullName: stored.selectedRepositoryFullName?.trim() || undefined,
    selectedRepositoryUrl: stored.selectedRepositoryUrl?.trim() || undefined,
    personalAccessToken: stored.personalAccessToken?.trim() || undefined,
  };
}

export async function getGitHubAPIStatus(): Promise<GitHubConnectionStatus> {
  const savedConnection = getPrimarySavedNangoConnection("github");
  const settings = await getGitHubOAuthSettings();
  const settingsConfigured = Boolean(settings.clientId && settings.clientSecret);

  if (savedConnection) {
    if (settings.selectedRepositoryFullName) {
      return {
        status: "connected",
        detail: `Connected${savedConnection.displayName ? ` as ${savedConnection.displayName}` : ""} for ${settings.selectedRepositoryFullName}.`,
        accountName: savedConnection.displayName,
        accountEmail: savedConnection.email,
        settingsConfigured: true,
        selectedRepositoryFullName: settings.selectedRepositoryFullName,
        selectedRepositoryUrl: settings.selectedRepositoryUrl,
      };
    }

    return {
      status: "incomplete",
      detail: `GitHub account connected${savedConnection.displayName ? ` as ${savedConnection.displayName}` : ""}, but repository selection is still required.`,
      accountName: savedConnection.displayName,
      accountEmail: savedConnection.email,
      settingsConfigured: true,
      selectedRepositoryFullName: settings.selectedRepositoryFullName,
      selectedRepositoryUrl: settings.selectedRepositoryUrl,
    };
  }

  if (settingsConfigured) {
    return {
      status: "incomplete",
      detail: "GitHub OAuth is configured. Connect a GitHub account to enable repository access for skill package management.",
      settingsConfigured,
      selectedRepositoryFullName: settings.selectedRepositoryFullName,
      selectedRepositoryUrl: settings.selectedRepositoryUrl,
    };
  }

  if (settings.clientId || settings.clientSecret) {
    return {
      status: "incomplete",
      detail: "Save both the GitHub client ID and client secret to finish the OAuth setup.",
      settingsConfigured: false,
    };
  }

  if (!isNangoConfigured()) {
    return {
      status: "not_connected",
      detail: "Configure the connection service first to enable GitHub access.",
      settingsConfigured: false,
    };
  }

  return {
    status: "not_connected",
    detail: "Configure GitHub OAuth to connect your GitHub account.",
    settingsConfigured: false,
    selectedRepositoryFullName: settings.selectedRepositoryFullName,
    selectedRepositoryUrl: settings.selectedRepositoryUrl,
  };
}

export async function saveGitHubOAuthSettings(input: {
  clientId?: string;
  clientSecret?: string;
}) {
  const current = await getGitHubOAuthSettings();
  const nextSettings: GitHubOAuthSettings = {
    clientId: input.clientId?.trim() || current.clientId,
    clientSecret: input.clientSecret?.trim() || current.clientSecret,
    redirectUri: getNangoOAuthCallbackUrl(),
    scopes: [...GITHUB_OAUTH_SCOPES],
  };

  await ensureGitHubIntegration(nextSettings);
  writeStoredSettings({
    redirectUri: nextSettings.redirectUri,
    selectedRepositoryFullName: current.selectedRepositoryFullName,
    selectedRepositoryUrl: current.selectedRepositoryUrl,
  });

  return nextSettings;
}

async function ensureGitHubIntegration(settings: GitHubOAuthSettings) {
  if (!settings.clientId || !settings.clientSecret) {
    return;
  }

  await ensureNangoIntegration({
    provider: "github",
    providerConfigKey: CINATRA_NANGO_PROVIDER_CONFIG_KEYS.github,
    displayName: "Cinatra GitHub",
    credentials: {
      type: "OAUTH2",
      client_id: settings.clientId,
      client_secret: settings.clientSecret,
      scopes: GITHUB_OAUTH_SCOPES_VALUE,
    },
  });
}

export async function getGitHubAccessToken(input?: {
  connectionId?: string;
}) {
  const savedConnection = resolveSavedGitHubConnection(input?.connectionId);

  if (savedConnection) {
    const connection = await getNangoConnection(
      savedConnection.providerConfigKey ?? CINATRA_NANGO_PROVIDER_CONFIG_KEYS.github,
      savedConnection.connectionId,
      {
        forceRefresh: true,
        refreshToken: true,
      },
    );
    const credentials = (connection as
      | {
          credentials?: {
            type?: string;
            access_token?: string;
          };
        }
      | null)?.credentials;

    if (credentials?.type === "OAUTH2" && typeof credentials.access_token === "string" && credentials.access_token.trim()) {
      return {
        accessToken: credentials.access_token,
        connection: savedConnection,
      };
    }
  }

  // Fall back to a stored Personal Access Token if Nango OAuth is unavailable.
  const stored = readStoredSettings();
  const pat = stored.personalAccessToken?.trim();
  if (pat) {
    return {
      accessToken: pat,
      connection: savedConnection ?? null,
    };
  }

  if (!savedConnection) {
    throw new Error("GitHub is not connected. Add a Personal Access Token in Administration → Skills to enable GitHub push.");
  }

  throw new Error("Unable to load the GitHub access token from Nango. Add a Personal Access Token in Administration → Skills as a fallback.");
}

async function githubApiFetch<T>(pathnameWithQuery: string) {
  const { accessToken } = await getGitHubAccessToken();
  const response = await fetch(`https://api.github.com${pathnameWithQuery}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    cache: "no-store",
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "message" in payload && typeof payload.message === "string"
        ? payload.message
        : "GitHub API request failed.";
    throw new Error(message);
  }

  return payload as T;
}

export async function listGitHubRepositories(): Promise<GitHubRepositoryOption[]> {
  const repositories: GitHubRepositoryOption[] = [];

  for (let page = 1; page <= 10; page += 1) {
    const payload = await githubApiFetch<Array<{
      id?: number;
      name?: string;
      full_name?: string;
      html_url?: string;
      private?: boolean;
      owner?: { login?: string };
      permissions?: {
        admin?: boolean;
        maintain?: boolean;
        push?: boolean;
        triage?: boolean;
        pull?: boolean;
      };
    }>>(`/user/repos?sort=updated&per_page=100&page=${page}&affiliation=owner,collaborator,organization_member`);

    const batch = payload.flatMap((repository) => {
      const owner = String(repository.owner?.login ?? "").trim();
      const repo = String(repository.name ?? "").trim();
      const fullName = String(repository.full_name ?? "").trim() || (owner && repo ? `${owner}/${repo}` : "");
      const url = String(repository.html_url ?? "").trim();

      if (!owner || !repo || !fullName || !url || typeof repository.id !== "number") {
        return [];
      }

      return [{
        id: repository.id,
        owner,
        repo,
        fullName,
        url,
        visibility: repository.private ? "private" as const : "public" as const,
        permissions: {
          admin: repository.permissions?.admin === true,
          maintain: repository.permissions?.maintain === true,
          push: repository.permissions?.push === true,
          triage: repository.permissions?.triage === true,
          pull: repository.permissions?.pull !== false,
        },
      }];
    });

    repositories.push(...batch);

    if (batch.length < 100) {
      break;
    }
  }

  return repositories.sort((left, right) => left.fullName.localeCompare(right.fullName));
}

export function saveGitHubPersonalAccessToken(pat: string | null) {
  const current = readStoredSettings();
  writeStoredSettings({
    ...current,
    personalAccessToken: pat?.trim() || undefined,
  });
}

export async function saveGitHubRepositorySelection(input: {
  repositoryFullName?: string;
}) {
  const current = await getGitHubOAuthSettings();
  const parsedRepository = parseSelectedRepository(input.repositoryFullName);

  if (!parsedRepository) {
    throw new Error("Choose a GitHub repository.");
  }

  const repositories = await listGitHubRepositories();
  const selectedRepository = repositories.find((repository) => repository.fullName === parsedRepository.fullName);
  if (!selectedRepository) {
    throw new Error("The selected GitHub repository is not available through the current connection.");
  }

  writeStoredSettings({
    redirectUri: current.redirectUri,
    selectedRepositoryFullName: selectedRepository.fullName,
    selectedRepositoryUrl: selectedRepository.url,
  });

  return selectedRepository;
}
