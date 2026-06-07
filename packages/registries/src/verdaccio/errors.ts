// -----------------------------------------------------------------------------
// Typed errors for the Verdaccio loader and HTTP helpers.
//
// InstanceNamespaceNotConfiguredError is the discriminator the publish-guard at
// packages/agents/src/actions.ts:publishToRegistry catches to return a
// structured failure to the UI.
//
// VerdaccioUnexpectedResponseError is thrown by createNpmUser when
// the live registry response shape diverges from the documented form.
// -----------------------------------------------------------------------------

export class InstanceNamespaceNotConfiguredError extends Error {
  readonly code = "INSTANCE_NAMESPACE_NOT_CONFIGURED" as const;

  constructor(message?: string) {
    super(
      message ??
        "Instance namespace is not configured. Run /setup/name to provision a registry identity.",
    );
    this.name = "InstanceNamespaceNotConfiguredError";
  }
}

export class VerdaccioUnexpectedResponseError extends Error {
  readonly code = "VERDACCIO_UNEXPECTED_RESPONSE" as const;

  constructor(message: string) {
    super(message);
    this.name = "VerdaccioUnexpectedResponseError";
  }
}
