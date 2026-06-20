// isRedirectError — discriminates Next.js's redirect() control-flow sentinel
// from a genuine failure.
//
// redirect() inside a server action does not return; it THROWS an error whose
// `digest` starts with "NEXT_REDIRECT". A client wrapper that awaits such an
// action inside try/catch must re-throw this sentinel so Next.js performs the
// navigation — catching it as a "failure" would show a false error toast on a
// SUCCESSFUL operation (e.g. a successful install that redirects to
// /configuration/extensions). This is the same predicate used across the host
// app (save-development-form.tsx, new-project-form.tsx); extracted here as a
// pure, non-"use client" module so it is directly unit-testable.
export function isRedirectError(error: unknown): boolean {
  return (
    typeof (error as { digest?: unknown })?.digest === "string" &&
    (error as { digest: string }).digest.startsWith("NEXT_REDIRECT")
  );
}
