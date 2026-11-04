/**
 * ToolNameAliasMap (TASK-0006: DeepSeek-safe tool name aliasing).
 *
 * ARTHUR's canonical tool identities are dotted (system.echo,
 * harness.create_job, memory.remember). DeepSeek's chat-completions API
 * requires every exposed function name to match ^[a-zA-Z0-9_-]+$ and rejects
 * dotted names with HTTP 400. This module is the provider-boundary alias
 * layer: canonical internal names stay unchanged everywhere else in ARTHUR,
 * and only the model provider (DeepSeekProvider) builds one map per model
 * request to translate names across the wire.
 *
 * Security invariants (enforced here and by DeepSeekProvider):
 *  1. The encoding is deterministic: "." -> "__".
 *  2. The mapping is bijective over the set of tools exposed in ONE model
 *     request; collisions are detected at construction time and fail closed
 *     BEFORE any provider request is sent (never a silent choice).
 *  3. Inbound names are resolved ONLY through the exact per-request map:
 *     an unknown provider name throws ToolNameAliasUnknownError, and the
 *     provider turns that into a fail-closed ProviderBadResponseError. A
 *     regex-valid name is never trusted on its own.
 *  4. providerToCanonical can never produce a canonical name that was not
 *     exposed in that request, so the model cannot manufacture an internal
 *     tool identity.
 */

/** Pattern DeepSeek enforces for function names. */
export const PROVIDER_SAFE_FUNCTION_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** Canonical-name character set used to fail fast on unencodable names. */
const CANONICAL_NAME_PATTERN = /^[a-zA-Z0-9_.-]+$/;

/**
 * Deterministic, reversible single-token encoding: every "." becomes "__".
 * Reversible because "__" is the only multi-char token that can appear and
 * the separator is never ambiguous at decode time (we never decode by
 * splitting; resolution goes through the per-request map instead).
 */
export function encodeProviderName(canonicalName: string): string {
  return canonicalName.replaceAll(".", "__");
}

export class ToolNameAliasError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolNameAliasError";
  }
}

/** Two distinct canonical names would map to the same provider name. */
export class ToolNameAliasCollisionError extends ToolNameAliasError {
  constructor(message: string) {
    super(message);
    this.name = "ToolNameAliasCollisionError";
  }
}

/** A canonical name cannot be safely encoded for the provider (invalid alias). */
export class ToolNameAliasInvalidError extends ToolNameAliasError {
  constructor(message: string) {
    super(message);
    this.name = "ToolNameAliasInvalidError";
  }
}

/** Inbound provider name that was not exposed in this model request. */
export class ToolNameAliasUnknownError extends ToolNameAliasError {
  constructor(message: string) {
    super(message);
    this.name = "ToolNameAliasUnknownError";
  }
}

export interface ToolSchemaNameLike {
  name: string;
}

/**
 * Per-request alias map. Constructed once per model request from the exact
 * tool set exposed in that request, then used for BOTH outbound schema/message
 * encoding and inbound tool-call resolution.
 */
export class ToolNameAliasMap {
  private readonly forward: ReadonlyMap<string, string>;
  private readonly reverse: ReadonlyMap<string, string>;

  private constructor(
    forward: ReadonlyMap<string, string>,
    reverse: ReadonlyMap<string, string>,
  ) {
    this.forward = forward;
    this.reverse = reverse;
  }

  /**
   * Build the map for exactly the given exposed canonical names. Throws
   * ToolNameAliasCollisionError when two canonical names share one alias and
   * ToolNameAliasInvalidError when a canonical name cannot be encoded safely.
   * Both fail closed BEFORE the provider request is sent.
   */
  static fromExposedNames(names: readonly string[]): ToolNameAliasMap {
    const canonicalToProvider = new Map<string, string>();
    const providerToCanonical = new Map<string, string>();

    for (const name of names) {
      if (typeof name !== "string" || name.length === 0) {
        throw new ToolNameAliasInvalidError("tool name must be a non-empty string");
      }
      if (!CANONICAL_NAME_PATTERN.test(name)) {
        throw new ToolNameAliasInvalidError(
          `tool name '${name}' contains characters that cannot be safely aliased`,
        );
      }
      if (canonicalToProvider.has(name)) {
        throw new ToolNameAliasCollisionError(`duplicate tool name in exposed set: '${name}'`);
      }
      const alias = encodeProviderName(name);
      if (!PROVIDER_SAFE_FUNCTION_NAME_PATTERN.test(alias)) {
        throw new ToolNameAliasInvalidError(
          `tool name '${name}' cannot be safely aliased (alias '${alias}' does not match ${PROVIDER_SAFE_FUNCTION_NAME_PATTERN})`,
        );
      }
      const existing = providerToCanonical.get(alias);
      if (existing !== undefined) {
        throw new ToolNameAliasCollisionError(
          `tool name alias collision: '${existing}' and '${name}' both map to provider name '${alias}'; refusing to expose an ambiguous tool set`,
        );
      }
      canonicalToProvider.set(name, alias);
      providerToCanonical.set(alias, name);
    }

    return new ToolNameAliasMap(canonicalToProvider, providerToCanonical);
  }

  /** Build the map from the tool schemas exposed in one ModelRequest. */
  static fromToolSchemas(schemas: readonly ToolSchemaNameLike[]): ToolNameAliasMap {
    return ToolNameAliasMap.fromExposedNames(schemas.map((schema) => schema.name));
  }

  /**
   * Outbound: canonical internal name -> provider-safe name. Total and
   * deterministic (pure encoding), so history messages that reference tools
   * from earlier requests are encoded consistently too.
   */
  canonicalToProvider(canonicalName: string): string {
    return encodeProviderName(canonicalName);
  }

  /**
   * Inbound: provider name -> canonical internal name. Resolves ONLY through
   * the exact per-request map. Throws ToolNameAliasUnknownError for any name
   * that was not exposed in this request; callers must fail closed.
   */
  providerToCanonical(providerName: string): string {
    const canonical = this.reverse.get(providerName);
    if (canonical === undefined) {
      throw new ToolNameAliasUnknownError(
        `provider tool name '${providerName}' was not exposed in this model request`,
      );
    }
    return canonical;
  }

  hasProviderName(providerName: string): boolean {
    return this.reverse.has(providerName);
  }

  hasCanonicalName(canonicalName: string): boolean {
    return this.forward.has(canonicalName);
  }

  /** Number of tools exposed in this request. */
  get size(): number {
    return this.forward.size;
  }

  /** Provider-safe names exposed in this request. */
  providerNames(): string[] {
    return [...this.reverse.keys()];
  }

  /** Canonical names exposed in this request. */
  canonicalNames(): string[] {
    return [...this.forward.keys()];
  }
}
