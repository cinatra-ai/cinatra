/** True when the application was built for production. */
export function builtForProduction(): boolean {
  return process.env.NODE_ENV === "production";
}
