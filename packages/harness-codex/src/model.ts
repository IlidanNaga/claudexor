import {
  codexProcessingCapability,
  prepareCodexProcessing,
  observeCodexProcessing,
  codexProcessingCost,
} from "./processing.js";
import type { ProcessingReceipt } from "@claudexor/schema";
import { validateModel, type ModelAdapter, type ModelAdapterContext } from "@claudexor/core";
import type {
  ControlModelCatalogResponse,
  ModelCallResult,
  ModelCatalogEntry,
  ModelNativeContinuation,
  ModelRoute,
} from "@claudexor/schema";
import { CLAUDEXOR_VERSION } from "@claudexor/util";
import {
  prepareCodexModelAuth,
  type CodexModelAuth,
  type CodexModelAuthDeps,
} from "./model-auth.js";
import {
  buildResponsesRequest,
  CodexModelError,
  emptyModelResult,
  providerProblem,
  readResponsesStream,
  record,
  text,
  validateCodexModelOptions,
} from "./responses.js";
import {
  codexCatalogClientVersion,
  describeCodexClientVersion,
  type CodexCatalogClientVersion,
} from "./http-client-version.js";
import { processingAdmissionProblem } from "./processing-refusal.js";
import { ResponseFailureCapture } from "./failure-evidence.js";

const ENDPOINT = "https://chatgpt.com/backend-api/codex";
const CLIENT = "claudexor";
const TURN_FORMAT = "codex.turn.v1";

/** Transport state belongs to a caller's live turn, never to assistant history. */
function prepareTurnContinuation(
  native: ModelNativeContinuation | null | undefined,
  route: ModelRoute,
): ModelNativeContinuation | null | undefined {
  if (native == null) return native;
  const turnState = text(record(native.payload)?.turnState);
  try {
    if (
      native.format !== TURN_FORMAT ||
      turnState === null ||
      new Headers({ "x-codex-turn-state": turnState }).get("x-codex-turn-state") !== turnState
    )
      throw new Error("invalid turn state");
  } catch {
    throw new CodexModelError(
      "invalid_continuation",
      "Codex transport continuation requires a valid, unchanged HTTP header value.",
    );
  }
  // Unknown or changed identity starts empty. A transport hint must never pin
  // an account or refuse otherwise valid generation on a newly selected route.
  return route.accountFingerprint &&
    native.route.accountFingerprint === route.accountFingerprint &&
    native.route.source === route.source &&
    native.route.credentialProfileId === route.credentialProfileId &&
    native.route.model === route.model
    ? native
    : null;
}

export interface CodexModelAdapterDeps extends CodexModelAuthDeps {
  fetch?: typeof fetch;
  /** The client version the catalog read declares (see http-client-version.ts). */
  clientVersion?: () => Promise<CodexCatalogClientVersion>;
}

function headers(auth: CodexModelAuth): Record<string, string> {
  return {
    Authorization: `Bearer ${auth.accessToken}`,
    "ChatGPT-Account-ID": auth.accountId,
    "Content-Type": "application/json",
    originator: CLIENT,
    "User-Agent": `${CLIENT}/${CLAUDEXOR_VERSION}`,
  };
}

function capacity(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** An expired/opaque access token's 401 is not proof that a new login is needed. */
function authenticatedProblem(
  response: Response,
  body: unknown,
  auth: CodexModelAuth,
  now: number,
) {
  const problem = providerProblem(response.status, body, response.headers);
  return response.status === 401 && (auth.expiresAt === null || auth.expiresAt <= now)
    ? new CodexModelError(
        "auth_refresh_failed",
        "Codex refused access credentials whose freshness could not be confirmed.",
        problem.context,
      ).problem
    : problem;
}

/** Exact backend metadata only; no CLI alias list, compaction limit, or historical default. */
export function parseCodexModelCatalog(value: unknown): ModelCatalogEntry[] {
  const models = record(value)?.models;
  if (!Array.isArray(models))
    throw new CodexModelError("catalog_unavailable", "Codex did not return a model catalog.");
  // Mirror ModelsManager::build_available_models + mark_default_by_picker_visibility
  // using THIS account's metadata. Incomplete metadata does not invent a default.
  const hasPriority = models.every((value) => {
    const item = record(value);
    return (
      Number.isSafeInteger(item?.priority) &&
      ["list", "hide", "none"].includes(String(item?.visibility))
    );
  });
  const ordered = hasPriority
    ? [...models].sort((a, b) => Number(record(a)?.priority) - Number(record(b)?.priority))
    : models;
  const defaultEntry = hasPriority
    ? (ordered.find((value) => record(value)?.visibility === "list") ?? ordered[0])
    : null;
  return ordered.map((value) => {
    const entry = record(value),
      id = text(entry?.slug);
    if (!entry || !id)
      throw new CodexModelError(
        "catalog_unavailable",
        "Codex returned an invalid model catalog entry.",
      );
    const efforts = Array.isArray(entry.supported_reasoning_levels)
      ? entry.supported_reasoning_levels
          .map((item) => text(record(item)?.effort))
          .filter((item): item is string => item !== null)
      : [];
    const modalities = Array.isArray(entry.input_modalities)
      ? entry.input_modalities.filter((item): item is string => typeof item === "string")
      : [];
    return {
      id,
      processing: codexProcessingCapability(entry, "codex.models"),
      label: text(entry.display_name),
      isDefault: value === defaultEntry,
      contextWindow: capacity(entry.context_window),
      maxContextWindow: capacity(entry.max_context_window),
      // Backend output-cap parameters are unsupported even when a model has a published output capacity.
      maxOutputTokens: capacity(entry.max_output_tokens),
      inputModalities: modalities,
      reasoningEfforts: efforts,
      defaultReasoningEffort: text(entry.default_reasoning_level),
      supportedOptions: [
        "toolChoice",
        "cacheKey",
        "serviceTier",
        "processingPreference",
        ...(efforts.length ? ["reasoningEffort"] : []),
        ...(entry.supports_parallel_tool_calls === true ? ["parallelToolCalls"] : []),
      ],
    };
  });
}

async function catalogFor(
  auth: CodexModelAuth,
  context: Omit<ModelAdapterContext, "onDispatch">,
  fetcher: typeof fetch,
  now: () => number,
  clientVersion: () => Promise<CodexCatalogClientVersion>,
): Promise<ControlModelCatalogResponse> {
  context.signal.throwIfAborted();
  // The backend lists only models whose minimum client version is at or below
  // the declared one; the declaration is this transport's own level, raised to
  // a newer installed CLI, never the installer pin (issue #339).
  const declared = await clientVersion();
  let response: Response;
  try {
    const query = `client_version=${encodeURIComponent(declared.version)}`;
    response = await fetcher(`${ENDPOINT}/models?${query}`, {
      headers: headers(auth),
      signal: context.signal,
      redirect: "error",
    });
  } catch {
    context.signal.throwIfAborted();
    throw new CodexModelError(
      "catalog_unavailable",
      "The selected Codex account's catalog could not be reached.",
      {},
      true,
    );
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    if (response.ok)
      throw new CodexModelError(
        "catalog_unavailable",
        "Codex returned an unreadable model catalog.",
      );
  }
  if (!response.ok) {
    const problem = authenticatedProblem(response, body, auth, now());
    const code = problem.code === "provider_failed" ? "catalog_unavailable" : problem.code;
    throw new CodexModelError(code, problem.message, problem.context, problem.retryable);
  }
  const models = parseCodexModelCatalog(body);
  return {
    source: "codex",
    credentialProfileId: context.profile.profile_id,
    accountFingerprint: auth.accountFingerprint,
    observedAt: new Date(now()).toISOString(),
    provenance: "provider_http",
    clientVersion: declared.version,
    clientVersionSource: declared.source,
    models,
  };
}

/** One adapter-owned generation, with the official CLI owning token refresh. */
export function createCodexModelAdapter(deps: CodexModelAdapterDeps = {}): ModelAdapter {
  const fetcher = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? Date.now;
  const clientVersion = deps.clientVersion ?? (() => codexCatalogClientVersion());
  return {
    id: "codex",
    async catalog(context) {
      const auth = await prepareCodexModelAuth(context.profile, context.signal, deps);
      return catalogFor(auth, context, fetcher, now, clientVersion);
    },
    async invoke(request, context) {
      let route: ModelRoute = {
        source: "codex",
        credentialProfileId: context.profile.profile_id,
        accountFingerprint: null,
        model: request.model,
      };
      let dispatched = false;
      const capture = new ResponseFailureCapture(context.captureFailureEvidence);
      let processing: ProcessingReceipt | undefined;
      let nativeContinuation: ModelNativeContinuation | null | undefined =
        request.nativeContinuation === undefined ? undefined : null;
      const withTurnState = (result: ModelCallResult): ModelCallResult => {
        const optIn = request.options.processingPreference !== undefined;
        const observed =
          optIn && processing
            ? observeCodexProcessing(processing, result.appliedOptions.serviceTier)
            : undefined;
        // The turn belongs to the model that ANSWERED, which is known only once
        // the terminal response names it. The header is captured before the body
        // is read, so it carries the requested route until this point, and a
        // terminal response that names another model rebinds it there.
        // A response that names NO model says nothing about whose turn this is:
        // a refused, torn or aborted body leaves the caller's own token exactly
        // as it was, so a live turn survives an incomplete answer instead of
        // being re-rolled into a fresh conversation.
        const answered = result.route.model;
        const turn =
          nativeContinuation && answered !== null && nativeContinuation.route.model !== answered
            ? { ...nativeContinuation, route: { ...nativeContinuation.route, model: answered } }
            : nativeContinuation;
        return {
          ...result,
          ...(nativeContinuation === undefined ? {} : { nativeContinuation: turn }),
          ...(observed
            ? {
                processing: observed,
                cost: { ...result.cost, processing: codexProcessingCost(observed) },
              }
            : {}),
        };
      };
      try {
        if (
          request.source !== "codex" ||
          (request.account.mode === "pin" &&
            request.account.profileId !== context.profile.profile_id)
        ) {
          throw new CodexModelError(
            "invalid_request",
            "The selected profile does not match the requested Codex route.",
          );
        }
        // Refuse unsupported explicit options before auth helpers, catalog I/O, or dispatch.
        validateCodexModelOptions(request.options);
        const auth = await prepareCodexModelAuth(context.profile, context.signal, deps);
        route = { ...route, accountFingerprint: auth.accountFingerprint };
        nativeContinuation = prepareTurnContinuation(request.nativeContinuation, route);
        const discovered = context.catalog;
        if (
          discovered &&
          (discovered.source !== route.source ||
            discovered.credentialProfileId !== route.credentialProfileId ||
            discovered.accountFingerprint !== auth.accountFingerprint)
        )
          throw new CodexModelError(
            "auth_changed",
            "The managed Codex account changed after model discovery.",
          );
        // The caller may hand off this operation's exact-account catalog.
        // Unknown identity cannot authorize reuse, but remains a usable route:
        // obtain fresh metadata rather than inventing a fingerprint or a limit.
        const catalog = discovered?.accountFingerprint
          ? discovered
          : await catalogFor(auth, context, fetcher, now, clientVersion);
        // The account catalog is a complete enumeration for the declared
        // client version, so absence IS proof here (INV-104): authoritative.
        const checked = validateModel(
          request.model,
          catalog.models.map((model) => model.id),
          "api",
          "authoritative",
        );
        const model = catalog.models.find((entry) => entry.id === request.model);
        // Strict on purpose: the catalog row is the request contract (efforts,
        // service tiers, windows). The refusal names the declared client
        // version, because that filter — not the account — decides the list.
        if (checked.status !== "ok" || !model)
          throw new CodexModelError(
            "model_unavailable",
            `The requested model is not in this account's Codex model catalog as served to ${describeCodexClientVersion(catalog)}.`,
            {
              clientVersion: catalog.clientVersion,
              clientVersionSource: catalog.clientVersionSource,
            },
          );
        if (
          request.options.reasoningEffort &&
          !model.reasoningEfforts.includes(request.options.reasoningEffort)
        ) {
          throw new CodexModelError(
            "unsupported_parameter",
            "The requested reasoning effort is not advertised for this model.",
            { parameter: "reasoningEffort" },
          );
        }
        processing = prepareCodexProcessing(
          request.options.processingPreference,
          model.processing,
          request.options.serviceTier,
        );
        const physicalRequest = processing?.submittedNative
          ? { ...request, options: { ...request.options, serviceTier: processing.submittedNative } }
          : request;
        const body = JSON.stringify(buildResponsesRequest(physicalRequest, route));
        const requestHeaders = new Headers(headers(auth));
        if (nativeContinuation) {
          requestHeaders.set(
            "x-codex-turn-state",
            record(nativeContinuation.payload)!.turnState as string,
          );
        }
        if (request.options.cacheKey !== undefined) {
          try {
            requestHeaders.set("session_id", request.options.cacheKey);
          } catch {
            throw new CodexModelError(
              "unsupported_parameter",
              "The requested cacheKey cannot be represented in a Codex HTTP header.",
              { parameter: "cacheKey" },
            );
          }
        }
        // HTTP header validation is preparation, not evidence of a physical send.
        context.signal.throwIfAborted();
        await context.onDispatch(route);
        dispatched = true;
        const response = await fetcher(`${ENDPOINT}/responses`, {
          method: "POST",
          headers: requestHeaders,
          body,
          signal: context.signal,
          redirect: "error",
        });
        if (!response.ok) {
          const result = emptyModelResult({ ...route, model: null });
          const error = await capture.readRefusal(response);
          result.problem = processingAdmissionProblem(
            authenticatedProblem(response, error, auth, now()),
            request.options,
            processing,
          );
          return withTurnState(capture.finish(result));
        }
        // Capture before reading the stream. A truncated body still owns this
        // same turn, and an already captured first header wins on later calls.
        const turnState = response.headers.get("x-codex-turn-state");
        if (nativeContinuation === null && turnState) {
          nativeContinuation = { route, format: TURN_FORMAT, payload: { turnState } };
        }
        return withTurnState(
          await readResponsesStream(response, route, context.captureFailureEvidence),
        );
      } catch (error) {
        const result = emptyModelResult({ ...route, model: null });
        result.outcome = dispatched ? "unknown" : "failed";
        result.problem =
          error instanceof CodexModelError
            ? error.problem
            : new CodexModelError(
                dispatched
                  ? "transport_unknown"
                  : context.signal.aborted
                    ? "cancelled"
                    : "model_unavailable",
                dispatched
                  ? "The Codex generation outcome is unknown; it was not retried."
                  : context.signal.aborted
                    ? "The model operation was cancelled before dispatch."
                    : "The Codex model request could not be prepared.",
              ).problem;
        if (dispatched) capture.caught(error);
        return withTurnState(dispatched ? capture.finish(result) : result);
      }
    },
  };
}
