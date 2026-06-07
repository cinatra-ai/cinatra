// Extracted from actions.ts because Next.js "use server" files may only
// export async functions. Importers (test files, callers that need `instanceof`)
// reach into this module directly.

export class ExtensionAlreadyPublicError extends Error {
  readonly code = "EXTENSION_ALREADY_PUBLIC";
  constructor(packageName: string) {
    super(`Extension ${packageName} is already public.`);
    this.name = "ExtensionAlreadyPublicError";
  }
}
