import { AgentHarnessError } from '../core/errors.js';
import type { ModelProviderAuth, ModelProviderWire } from './model-provider-definitions.js';

/**
 * What the runtime honours *today*.
 *
 * The `model_providers` schema deliberately stores a wider shape than the
 * runtime can act on, so that records survive the backend-portability work
 * without a migration. To keep the difference from becoming a silent drop,
 * every create and update is validated against this table and rejected when it
 * names something the runtime would ignore.
 *
 * When the portability phases land, this file is the only thing that changes.
 */
export const RUNTIME_SUPPORT = {
  /** NVIDIA NIM and Bedrock API-key endpoints both use chat-completions. */
  providers: ['openrouter', 'nvidia', 'bedrock', 'openai-compatible'] as const,
  /**
   * `Authorization: Bearer <key>` is hardcoded at
   * `src/models/openai-compatible-provider.ts:62`, so `header` cannot be
   * expressed. A blank credential throws at
   * `src/models/openai-compatible-provider.ts:46`, so `none` cannot either.
   */
  authKinds: ['bearer'] as const,
  /**
   * `maxTokensField` and `reasoningField` are the wire knobs the adapter
   * exposes. The others have no seam:
   * - `streamOptions`: `stream_options` is fixed to `{ include_usage: true }`
   *   in the request body of `openai-compatible-provider.ts`.
   * - `usageReporting`: usage events are additive, with no last-write-wins mode.
   * - `toolCallIdMode`: tool-call ids and names are concatenated with `+=`.
   */
  wireFields: ['maxTokensField', 'reasoningField'] as const,
  /**
   * `contextWindow` and `maxOutputTokens` are honoured because the entrypoint
   * reads them off the record and passes them as the session's token ceilings.
   * `supportsReasoning` is honoured because it decides whether the adapter asks
   * the gateway for deliberation at all. The rest are stored and shape-validated
   * only, and the registry logs once per resolution that they are not in effect.
   */
  capabilitiesHonoured: ['contextWindow', 'maxOutputTokens', 'supportsReasoning'] as const,
} as const;

/**
 * Request headers the platform forwards. Mirrors the allowlist the replaced
 * `DefaultPlatformModelResolver.safeModelHeaders` applied, except that a
 * non-allowlisted header is now rejected at write time instead of being
 * dropped silently on every request.
 */
export const SUPPORTED_HEADER_NAMES = [
  'HTTP-Referer',
  'X-OpenRouter-Title',
  'X-OpenRouter-Categories',
] as const;

export type SupportedProvider = (typeof RUNTIME_SUPPORT.providers)[number];
export type SupportedAuthKind = (typeof RUNTIME_SUPPORT.authKinds)[number];
export type SupportedWireField = (typeof RUNTIME_SUPPORT.wireFields)[number];

const WIRE_FIELD_REASONS: Readonly<Record<keyof ModelProviderWire, string>> = {
  maxTokensField: '',
  reasoningField: '',
  streamOptions: 'stream_options is fixed to { include_usage: true }',
  usageReporting: 'usage events are additive with no alternative mode',
  toolCallIdMode: 'tool-call ids are accumulated by concatenation',
};

/** The subset of a record the support gate inspects. */
export type RuntimeSupportCheckInput = {
  provider: string;
  auth: ModelProviderAuth;
  wire?: ModelProviderWire | undefined;
  headers?: Readonly<Record<string, string>> | undefined;
};

/**
 * Rejects any stored shape the runtime would ignore. Called on every create and
 * update, and again at resolution as defence in depth.
 */
export function assertRuntimeSupport(record: RuntimeSupportCheckInput): void {
  assertSupportedProvider(record.provider);
  assertSupportedAuth(record.auth);
  assertSupportedWire(record.wire, record.provider);
  assertSupportedHeaders(record.headers);
}

function assertSupportedProvider(provider: string): void {
  if (!(RUNTIME_SUPPORT.providers as readonly string[]).includes(provider)) {
    throw new AgentHarnessError(
      `Unsupported field 'provider': '${provider}' has no adapter in this runtime. ` +
        `Supported: ${RUNTIME_SUPPORT.providers.join(', ')}.`,
      'UNSUPPORTED_MODEL_PROVIDER',
    );
  }
}

function assertSupportedAuth(auth: ModelProviderAuth): void {
  if ((RUNTIME_SUPPORT.authKinds as readonly string[]).includes(auth.kind)) return;
  const reason =
    auth.kind === 'header'
      ? 'Authorization: Bearer is hardcoded (openai-compatible-provider.ts:62), so a custom auth header cannot be sent'
      : 'a blank credential is rejected by the adapter constructor (openai-compatible-provider.ts:46)';
  throw new AgentHarnessError(
    `Unsupported field 'auth.kind': '${auth.kind}' is not honoured because ${reason}. ` +
      `Supported: ${RUNTIME_SUPPORT.authKinds.join(', ')}.`,
    'UNSUPPORTED_MODEL_AUTH_KIND',
  );
}

function assertSupportedWire(wire: ModelProviderWire | undefined, provider: string): void {
  if (!wire) return;
  for (const field of Object.keys(wire) as Array<keyof ModelProviderWire>) {
    if (wire[field] === undefined) continue;
    if (!(RUNTIME_SUPPORT.wireFields as readonly string[]).includes(field)) {
      throw new AgentHarnessError(
        `Unsupported field 'wire.${field}': ${WIRE_FIELD_REASONS[field]}. ` +
          `Supported: ${RUNTIME_SUPPORT.wireFields.map((name) => `wire.${name}`).join(', ')}.`,
        'UNSUPPORTED_MODEL_WIRE_FIELD',
      );
    }
  }
  if (wire.maxTokensField !== undefined && provider === 'openrouter') {
    throw new AgentHarnessError(
      "Unsupported field 'wire.maxTokensField': OpenRouter normalizes on max_tokens " +
        '(openrouter-provider.ts:86-87), so an override would be ignored. ' +
        'Omit it, or use provider openai-compatible.',
      'UNSUPPORTED_MODEL_WIRE_FIELD',
    );
  }
}

function assertSupportedHeaders(headers: Readonly<Record<string, string>> | undefined): void {
  for (const name of Object.keys(headers ?? {})) {
    if (!(SUPPORTED_HEADER_NAMES as readonly string[]).includes(name)) {
      throw new AgentHarnessError(
        `Unsupported field 'headers.${name}': the platform forwards only ` +
          `${SUPPORTED_HEADER_NAMES.join(', ')}; any other header would be dropped before the request.`,
        'UNSUPPORTED_MODEL_HEADER',
      );
    }
  }
}
