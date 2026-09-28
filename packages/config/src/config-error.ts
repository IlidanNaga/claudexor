export class ConfigParseError extends Error {
  /** Typed problem projection (INV-021 fail-loudly, without a generic 500):
   * the control-api problemBody duck-types these fields, and the MCP bridge's
   * code-prefix rendering carries them to agent hosts. */
  public readonly status = 422;
  public readonly code = "config_invalid";
  public readonly retryable = false;
  public readonly requiredActions: string[];

  constructor(
    public readonly path: string,
    cause: unknown,
  ) {
    super(
      `invalid Claudexor YAML config at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "ConfigParseError";
    this.requiredActions = [
      `inspect and fix ${path} against the current schema`,
      // Only swept config files ever get sibling backups; trust files and env
      // pseudo-paths must not advertise a .bak-* that cannot exist.
      ...(path.endsWith("config.yaml")
        ? [`or restore it from the newest sibling backup (${path}.bak-*)`]
        : []),
    ];
  }
}
