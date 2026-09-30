import { createServer, type RequestListener } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { getGlobalDispatcher, setGlobalDispatcher, ProxyAgent, type Dispatcher } from "undici";
import { RequestDelivery } from "./request-delivery.js";

const originalDispatcher = getGlobalDispatcher();
afterEach(() => setGlobalDispatcher(originalDispatcher));

async function endpoint(handle: RequestListener) {
  const server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing loopback listener");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const send = (url: string, delivery: RequestDelivery) =>
  fetch(url, {
    method: "POST",
    headers: { "content-length": String(delivery.bytes.length) },
    ...delivery.request(),
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });

describe("request delivery proof on the existing dispatcher", () => {
  it("keeps an existing proxy dispatcher and its connection ownership", async () => {
    const destination = await endpoint((req, res) => {
      req.resume();
      req.on("end", () => res.end("through proxy"));
    });
    const sockets: Duplex[] = [];
    let tunnels = 0;
    const proxy = createServer();
    proxy.on("connect", (_req, downstream, head) => {
      tunnels += 1;
      const upstream = connect(Number(new URL(destination.url).port), "127.0.0.1", () => {
        downstream.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        downstream.pipe(upstream).pipe(downstream);
      });
      sockets.push(upstream, downstream);
      downstream.on("error", () => upstream.destroy());
      upstream.on("error", () => downstream.destroy());
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("missing proxy listener");
    const owner = new ProxyAgent(`http://127.0.0.1:${address.port}`);
    setGlobalDispatcher(owner);
    try {
      const delivery = new RequestDelivery("x".repeat(200_000));
      const response = await send(destination.url, delivery);
      expect(await response.text()).toBe("through proxy");
      expect(tunnels).toBe(1);
      expect(getGlobalDispatcher()).toBe(owner);
      expect(delivery.facts()).toMatchObject({ handedOffBytes: 200_000, responseReceived: true });
      expect(delivery.notDelivered()).toBeNull();
    } finally {
      await owner.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      await destination.close();
    }
  });

  it("preserves exact UTF-8 bytes, length and concurrent request identity", async () => {
    const received: Buffer[] = [];
    const server = await endpoint((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        received.push(Buffer.concat(chunks));
        res.end("ok");
      });
    });
    const requests = Array.from(
      { length: 5 },
      (_, i) => new RequestDelivery(JSON.stringify({ text: "Я🦉".repeat(20_000 + i) })),
    );
    try {
      await Promise.all(
        requests.map(async (request) => {
          const response = await send(server.url, request);
          expect(await response.text()).toBe("ok");
        }),
      );
      for (const request of requests) {
        expect(received.some((bytes) => bytes.equals(request.bytes))).toBe(true);
        expect(request.facts()).toMatchObject({
          handedOffBytes: request.bytes.length,
          dispatches: 1,
          responseReceived: true,
        });
        expect(request.notDelivered()).toBeNull();
      }
      expect(getGlobalDispatcher()).toBe(originalDispatcher);
    } finally {
      await server.close();
    }
  });

  it("proves an early incomplete upload, but never a full handoff followed by a broken connection", async () => {
    const server = await endpoint((req, res) => {
      req.on("error", () => {});
      req.on("data", () => {
        if (req.url === "/early") req.socket.destroy();
      });
      req.on("end", () => {
        if (req.url === "/late") req.socket.destroy();
        else res.end("ok");
      });
    });
    try {
      const early = new RequestDelivery("x".repeat(8 * 1024 * 1024));
      await expect(send(server.url + "/early", early)).rejects.toThrow();
      expect(early.notDelivered()).toMatchObject({
        basis: "incomplete_upload",
        state: "not_delivered",
      });
      expect(early.facts().handedOffBytes).toBeLessThan(early.bytes.length);
      const late = new RequestDelivery("x".repeat(200_000));
      await expect(send(server.url + "/late", late)).rejects.toThrow();
      expect(late.facts().handedOffBytes).toBe(late.bytes.length);
      expect(late.notDelivered()).toBeNull();
    } finally {
      await server.close();
    }
  });

  it("proves a refused connection through the dispatch callback, preserving an unobserved byte count", async () => {
    const server = await endpoint((_req, res) => res.end("unused"));
    await server.close();
    const delivery = new RequestDelivery("complete body");
    await expect(send(server.url, delivery)).rejects.toThrow();
    expect(delivery.notDelivered()).toMatchObject({
      basis: "connect_failure",
      handedOffBytes: null,
      observedChunks: 0,
      errorCodes: ["ECONNREFUSED"],
    });
  });

  it.each([
    "UND_ERR_CONNECT_TIMEOUT",
    "ENOTFOUND",
    "EAI_AGAIN",
    "CERT_HAS_EXPIRED",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
  ])("requires the pre-connect callback provenance for %s", async (code) => {
    setGlobalDispatcher(
      new Proxy(originalDispatcher, {
        get(target, key) {
          if (key === "dispatch")
            return (_opts: unknown, handler: Dispatcher.DispatchHandler) => {
              handler.onError?.(Object.assign(new Error("fixture connector refusal"), { code }));
              return true;
            };
          return Reflect.get(target, key, target);
        },
      }),
    );
    const delivery = new RequestDelivery("body");
    await expect(send("http://localhost/", delivery)).rejects.toThrow();
    expect(delivery.notDelivered()).toMatchObject({ basis: "connect_failure", errorCodes: [code] });
    const unobserved = new RequestDelivery("body");
    // An injected fetch can throw the same code without using our dispatcher.
    await expect(
      Promise.reject(Object.assign(new Error("custom fetch"), { code })),
    ).rejects.toThrow();
    expect(unobserved.notDelivered()).toBeNull();
  });

  it("does not erase a prior response or handoff when a later same-fetch request cannot connect", async () => {
    const delivery = new RequestDelivery("body");
    const observer = delivery.request().dispatcher;
    let attempt = 0;
    setGlobalDispatcher(
      new Proxy(originalDispatcher, {
        get(target, key) {
          if (key === "dispatch")
            return (_opts: unknown, handler: Dispatcher.DispatchHandler) => {
              if (attempt++ === 0) {
                handler.onConnect?.(() => {});
                // Native implementations pass the chunk, despite the declaration
                // in both undici-types6 and undici7 describing two numeric args.
                (handler.onBodySent as unknown as (chunk: Buffer) => void)?.(Buffer.from("body"));
              }
              handler.onError?.(Object.assign(new Error("connector"), { code: "ECONNREFUSED" }));
              return true;
            };
          return Reflect.get(target, key, target);
        },
      }),
    );
    const options = { origin: "http://localhost", path: "/", method: "POST" as const };
    const handler = {
      onConnect() {},
      onError() {},
      onHeaders() {
        return true;
      },
      onData() {
        return true;
      },
      onComplete() {},
    };
    observer.dispatch(options, handler);
    observer.dispatch(options, handler);
    expect(delivery.facts().dispatches).toBe(2);
    expect(delivery.notDelivered()).toBeNull();
  });

  it("forwards an unfamiliar public callback shape without throwing or inventing bytes", () => {
    const observed: unknown[][] = [];
    setGlobalDispatcher(
      new Proxy(originalDispatcher, {
        get(target, key) {
          if (key === "dispatch")
            return (_opts: unknown, handler: Dispatcher.DispatchHandler) => {
              handler.onBodySent?.(2, 2);
              handler.onError?.(Object.assign(new Error("connector"), { code: "ECONNREFUSED" }));
              return false;
            };
          return Reflect.get(target, key, target);
        },
      }),
    );
    const delivery = new RequestDelivery("body");
    const returned = delivery.request().dispatcher.dispatch(
      { origin: "http://localhost", path: "/", method: "POST" },
      {
        onBodySent: (...args: unknown[]) => {
          observed.push(args);
        },
        onError() {},
      },
    );
    expect(returned).toBe(false);
    expect(observed).toEqual([[2, 2]]);
    expect(delivery.facts().handedOffBytes).toBeNull();
    expect(delivery.notDelivered()).toBeNull();
  });
});
