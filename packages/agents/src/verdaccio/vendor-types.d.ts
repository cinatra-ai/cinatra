// Minimal type stubs for libnpmpublish and pacote.
// These packages ship no .d.ts files and have no @types counterparts.

declare module "libnpmpublish" {
  export function publish(
    manifest: Record<string, unknown>,
    tarData: Buffer,
    opts: Record<string, unknown>,
  ): Promise<void>;
}

declare module "pacote" {
  export function packument(
    spec: string,
    opts?: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;

  export function tarball(
    spec: string,
    opts?: Record<string, unknown>,
  ): Promise<Buffer>;

  export function extract(
    spec: string,
    dest: string,
    opts?: Record<string, unknown>,
  ): Promise<void>;
}
