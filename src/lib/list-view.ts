export function getListViewCookieName(basePath: string) {
  return `cinatra_view_${basePath.replace(/[^a-z0-9]/gi, "_").replace(/^_+|_+$/g, "").toLowerCase()}`;
}

export function getListConfigCookieName(basePath: string) {
  return `cinatra_list_${basePath.replace(/[^a-z0-9]/gi, "_").replace(/^_+|_+$/g, "").toLowerCase()}`;
}

export type StoredListViewConfig = {
  query?: string;
  sort?: string;
  dir?: "asc" | "desc";
  filters?: Record<string, string>;
  columns?: string[];
};

export type StoredListConfig = {
  cards?: StoredListViewConfig;
  table?: StoredListViewConfig;
};

export function parseListConfigCookie(rawValue: string | undefined): StoredListConfig {
  if (!rawValue) {
    return {};
  }

  try {
    return JSON.parse(decodeURIComponent(rawValue)) as StoredListConfig;
  } catch {
    return {};
  }
}

export function serializeListConfigCookie(config: StoredListConfig) {
  return encodeURIComponent(JSON.stringify(config));
}
