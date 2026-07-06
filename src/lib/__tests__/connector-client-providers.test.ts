// cinatra#975 Wave 3 CORE EVICTION — the connector-client resolvers. The five
// vendor connection/instance clients moved OUT of core into their owning
// connectors, which register them under the SAME host capability ids from
// their register(ctx). Core resolves them lazily HERE with an OWNER PIN
// derived from the connectors-catalog registry (never a core package literal)
// plus a structural guard, and MUST degrade deterministically: `resolve*()`
// returns null for visibly-degrading surfaces; `require*()` FAILS LOUD naming
// the catalog-derived owner. This test pins the degradation, the owner pin
// (anti-spoof), and the structural-guard rejection — the Wave-2
// widget-auth-provider test pattern.

import { describe, expect, it, beforeEach } from "vitest";

import {
  registerCapabilityProvider,
  __resetCapabilityRegistry,
} from "@/lib/extension-capabilities-registry";
import { getConnectorDescriptorBySlug } from "@cinatra-ai/connectors-catalog/descriptors.mjs";
import {
  resolveWordPressInstanceAdmin,
  requireWordPressInstanceAdmin,
  requireWordPressContentClient,
  resolveDrupalInstanceAdmin,
  requireDrupalInstanceAdmin,
  resolveLinkedInConnectionClient,
  requireLinkedInConnectionClient,
  resolveGitHubConnectionClient,
  requireGitHubConnectionClient,
  resolveYouTubeConnectionClient,
} from "@/lib/connector-client-providers";

// The real-world owner values, pinned HERE (tests are gate-exempt) so a
// silent connectors-catalog regression is caught.
const OWNERS = {
  wordpress: "@cinatra-ai/wordpress-mcp-connector",
  drupal: "@cinatra-ai/drupal-mcp-connector",
  linkedin: "@cinatra-ai/linkedin-connector",
  github: "@cinatra-ai/github-connector",
  youtube: "@cinatra-ai/youtube-connector",
} as const;

const fn = () => {};
const wordpressAdminImpl = {
  listInstances: fn,
  getAPIStatus: fn,
  getAPISettings: fn,
  readInstanceById: fn,
  deleteInstance: fn,
  webhookSubscriptions: { list: fn, register: fn, remove: fn },
  validateWordPressInstanceConnection: fn,
  saveWordPressInstance: fn,
  saveWordPressInstanceFromNangoConnection: fn,
  persistLocalDevWordPressInstanceUnvalidated: fn,
  setWordPressInstanceBlogConnector: fn,
  saveWordPressLoggingSettings: fn,
  getWordPressLoggingSettings: fn,
  listWordPressInstances: fn,
  readLatestPublishedWordPressPost: fn,
};
const wordpressContentImpl = {
  createDraft: fn,
  readPost: fn,
  readPostStatus: fn,
  listPublishedPosts: fn,
  deletePost: fn,
  uploadMedia: fn,
  updateDraftMeta: fn,
  updatePost: fn,
};
const drupalAdminImpl = {
  listInstances: fn,
  getAPIStatus: fn,
  saveInstance: fn,
  deleteInstance: fn,
  devPersistLocalInstanceUnvalidated: fn,
};
const linkedinImpl = {
  getStatus: fn,
  getSettings: fn,
  listAccounts: fn,
  listDestinations: fn,
  publishPost: fn,
  saveAccountFromNangoConnection: fn,
  getLoggingSettings: fn,
};
const githubImpl = {
  getStatus: fn,
  getOAuthSettings: fn,
  listRepositories: fn,
  saveOAuthSettings: fn,
  saveRepositorySelection: fn,
  getAccessToken: fn,
  getAccessTokenForAuthorizedConnection: fn,
  savePersonalAccessToken: fn,
};
const youtubeImpl = {
  getConfiguredAccessToken: fn,
  getStatus: fn,
  clearSettings: fn,
};

describe("connector-client-providers — owner-pinned lazy resolution + fail-loud degradation", () => {
  beforeEach(() => {
    __resetCapabilityRegistry();
  });

  it("derives every owner pin from the connectors-catalog registry (the sanctioned identity source)", () => {
    expect(getConnectorDescriptorBySlug("wordpress-mcp-connector")?.packageId).toBe(
      OWNERS.wordpress,
    );
    expect(getConnectorDescriptorBySlug("drupal-mcp-connector")?.packageId).toBe(OWNERS.drupal);
    expect(getConnectorDescriptorBySlug("linkedin-connector")?.packageId).toBe(OWNERS.linkedin);
    expect(getConnectorDescriptorBySlug("github-connector")?.packageId).toBe(OWNERS.github);
    expect(getConnectorDescriptorBySlug("youtube-connector")?.packageId).toBe(OWNERS.youtube);
  });

  it("resolve*() returns null when the owning connector is absent (visible degradation)", () => {
    expect(resolveWordPressInstanceAdmin()).toBeNull();
    expect(resolveDrupalInstanceAdmin()).toBeNull();
    expect(resolveLinkedInConnectionClient()).toBeNull();
    expect(resolveGitHubConnectionClient()).toBeNull();
    expect(resolveYouTubeConnectionClient()).toBeNull();
  });

  it("require*() FAILS LOUD naming the catalog-derived owner when the capability is unresolved", () => {
    expect(() => requireWordPressInstanceAdmin()).toThrow(
      /wordpress-mcp" unavailable[\s\S]*wordpress-mcp-connector/,
    );
    expect(() => requireWordPressContentClient()).toThrow(
      /wordpress-content" unavailable[\s\S]*wordpress-mcp-connector/,
    );
    expect(() => requireDrupalInstanceAdmin()).toThrow(
      /drupal-mcp" unavailable[\s\S]*drupal-mcp-connector/,
    );
    expect(() => requireLinkedInConnectionClient()).toThrow(
      /linkedin-connection" unavailable[\s\S]*linkedin-connector/,
    );
    expect(() => requireGitHubConnectionClient()).toThrow(
      /github-connection" unavailable[\s\S]*github-connector/,
    );
  });

  it("resolves each connector-registered client once published under the owning package", () => {
    registerCapabilityProvider("@cinatra-ai/host:wordpress-mcp", {
      packageName: OWNERS.wordpress,
      impl: wordpressAdminImpl,
    });
    registerCapabilityProvider("@cinatra-ai/host:wordpress-content", {
      packageName: OWNERS.wordpress,
      impl: wordpressContentImpl,
    });
    registerCapabilityProvider("@cinatra-ai/host:drupal-mcp", {
      packageName: OWNERS.drupal,
      impl: drupalAdminImpl,
    });
    registerCapabilityProvider("@cinatra-ai/host:linkedin-connection", {
      packageName: OWNERS.linkedin,
      impl: linkedinImpl,
    });
    registerCapabilityProvider("@cinatra-ai/host:github-connection", {
      packageName: OWNERS.github,
      impl: githubImpl,
    });
    registerCapabilityProvider("@cinatra-ai/host:youtube-connection", {
      packageName: OWNERS.youtube,
      impl: youtubeImpl,
    });

    expect(resolveWordPressInstanceAdmin()).toBe(wordpressAdminImpl);
    expect(requireWordPressInstanceAdmin()).toBe(wordpressAdminImpl);
    expect(requireWordPressContentClient()).toBe(wordpressContentImpl);
    expect(resolveDrupalInstanceAdmin()).toBe(drupalAdminImpl);
    expect(requireDrupalInstanceAdmin()).toBe(drupalAdminImpl);
    expect(resolveLinkedInConnectionClient()).toBe(linkedinImpl);
    expect(requireLinkedInConnectionClient()).toBe(linkedinImpl);
    expect(resolveGitHubConnectionClient()).toBe(githubImpl);
    expect(requireGitHubConnectionClient()).toBe(githubImpl);
    expect(resolveYouTubeConnectionClient()).toBe(youtubeImpl);
  });

  it("ANTI-SPOOF: a same-id provider from a NON-owner package is never resolved", () => {
    registerCapabilityProvider("@cinatra-ai/host:wordpress-mcp", {
      packageName: "@evil/impostor-connector",
      impl: wordpressAdminImpl,
    });
    registerCapabilityProvider("@cinatra-ai/host:youtube-connection", {
      packageName: "@evil/impostor-connector",
      impl: youtubeImpl,
    });
    expect(resolveWordPressInstanceAdmin()).toBeNull();
    expect(resolveYouTubeConnectionClient()).toBeNull();
    expect(() => requireWordPressInstanceAdmin()).toThrow(/unavailable/);
  });

  it("STRUCTURAL GUARD: a malformed owner-registered impl is rejected (fail closed), incl. a stale pre-Wave-3 contract-only registration", () => {
    // Missing the additive relocated members (a stale contract-only impl).
    registerCapabilityProvider("@cinatra-ai/host:wordpress-mcp", {
      packageName: OWNERS.wordpress,
      impl: {
        listInstances: fn,
        getAPIStatus: fn,
        getAPISettings: fn,
        readInstanceById: fn,
        deleteInstance: fn,
        webhookSubscriptions: { list: fn, register: fn, remove: fn },
      },
    });
    // Not even an object.
    registerCapabilityProvider("@cinatra-ai/host:youtube-connection", {
      packageName: OWNERS.youtube,
      impl: "not-a-service",
    });
    // Missing the additive status/clear members.
    registerCapabilityProvider("@cinatra-ai/host:github-connection", {
      packageName: OWNERS.github,
      impl: { getStatus: fn, getOAuthSettings: fn, listRepositories: fn },
    });
    expect(resolveWordPressInstanceAdmin()).toBeNull();
    expect(resolveYouTubeConnectionClient()).toBeNull();
    expect(resolveGitHubConnectionClient()).toBeNull();
  });
});
