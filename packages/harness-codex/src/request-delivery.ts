import type { Dispatcher } from "undici";
import { existingDispatcher } from "./dispatcher-accessor.cjs";

// Typed connector failures are evidence only on the target dispatcher's error
// callback, before its onConnect. A thrown fetch error alone proves nothing.
const CONNECT_FAILURES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_TLS_HANDSHAKE_TIMEOUT",
]);

interface SendObservation {
  connected: boolean;
  chunks: number;
  handed: number;
  response: boolean;
  errorCode: string | null;
  supported: boolean;
}

/** One exact JSON body's transport observations, never a retry or a socket owner.
 * Handoff is an UPPER bound on peer receipt. Full handoff is still unknown.
 * A custom fetch/dispatcher which emits no callbacks supplies no evidence.
 */
export class RequestDelivery {
  readonly bytes: Buffer;
  private readonly sends: SendObservation[] = [];

  constructor(body: string) {
    this.bytes = Buffer.from(body, "utf8");
  }

  request(): {
    body: ReadableStream<Uint8Array>;
    duplex: "half";
    dispatcher: NonNullable<RequestInit["dispatcher"]>;
  } {
    let offset = 0;
    const bytes = this.bytes;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === bytes.length) return controller.close();
        const chunk = bytes.subarray(offset, offset + 64 * 1024);
        offset += chunk.length;
        controller.enqueue(chunk);
      },
    });
    let delegate: Dispatcher | undefined;
    const selected = () => (delegate ??= existingDispatcher());
    // Resolve lazily INSIDE fetch. Preserve every property (including
    // isMockActive), callback receiver and dispatch return value of its owner.
    const dispatcher = new Proxy({} as Dispatcher, {
      get: (_target, key) => {
        const target = selected();
        if (key === "dispatch")
          return (options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler) => {
            const observation: SendObservation = {
              connected: false,
              chunks: 0,
              handed: 0,
              response: false,
              errorCode: null,
              supported: true,
            };
            this.sends.push(observation);
            return target.dispatch(
              options,
              new Proxy(handler, {
                get: (original, method) => {
                  const fn = Reflect.get(original, method, original);
                  if (method === "onBodySent")
                    return (...args: unknown[]) => {
                      const chunk = args[0];
                      // Native Undici supplies the actual chunk. Its published
                      // types also describe numeric callbacks: preserve those, but
                      // do not mistake an unfamiliar implementation for byte proof.
                      if (typeof chunk === "string" || chunk instanceof Uint8Array) {
                        observation.chunks += 1;
                        observation.handed += Buffer.byteLength(chunk);
                      } else observation.supported = false;
                      return fn?.apply(original, args);
                    };
                  if (typeof fn !== "function") return fn;
                  return (...args: unknown[]) => {
                    if (method === "onConnect") observation.connected = true;
                    if (method === "onHeaders" || method === "onResponseStarted")
                      observation.response = true;
                    if (method === "onError") {
                      const error = args[0] as { code?: unknown } | undefined;
                      observation.errorCode = typeof error?.code === "string" ? error.code : null;
                    }
                    return fn.apply(original, args);
                  };
                },
              }),
            );
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    // Node's fetch declarations bundle an older Undici type version. The
    // forwarding dispatch interface is shared; no FormData crosses this seam.
    return {
      body,
      duplex: "half",
      dispatcher: dispatcher as unknown as NonNullable<RequestInit["dispatcher"]>,
    };
  }

  facts() {
    const chunks = this.sends.reduce((sum, send) => sum + send.chunks, 0);
    return {
      bodyBytes: this.bytes.length,
      handedOffBytes:
        chunks && this.sends.every((send) => send.supported)
          ? this.sends.reduce((sum, send) => sum + send.handed, 0)
          : null,
      observedChunks: chunks,
      dispatches: this.sends.length,
      responseReceived: this.sends.some((send) => send.response),
    };
  }

  notDelivered() {
    const facts = this.facts();
    const connectFailure = (send: SendObservation) =>
      send.supported &&
      !send.connected &&
      send.chunks === 0 &&
      send.errorCode !== null &&
      CONNECT_FAILURES.has(send.errorCode);
    if (!this.sends.length || facts.responseReceived) return null;
    const allConnect = this.sends.every(connectFailure);
    // Include EVERY send, including any dispatcher-internal retry. A prior
    // full/unknown handoff cannot be erased by a later connect failure.
    const partial = this.sends.every(
      (send) =>
        connectFailure(send) ||
        (send.supported && send.chunks > 0 && send.handed < this.bytes.length),
    );
    if (!allConnect && !partial) return null;
    return {
      state: "not_delivered" as const,
      basis: allConnect ? ("connect_failure" as const) : ("incomplete_upload" as const),
      ...facts,
      errorCodes: this.sends.map((send) => send.errorCode),
    };
  }
}
