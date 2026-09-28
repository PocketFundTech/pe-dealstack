// Adapter that lets a Next.js Route Handler invoke a vanilla Express
// handler. We synthesise just enough of Node's IncomingMessage and
// ServerResponse for Express's middleware chain (helmet, cors, body-parser,
// multer, etc.) to behave normally, then expose whatever Express writes as a
// Web Response. The shape supports both buffered (res.json/send) and chunked
// (manual res.write before res.end) responses so streaming works if a future
// route ever returns SSE — today's traffic is all buffered.

import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { after, type NextRequest } from "next/server";

export type ExpressHandler = (
  req: unknown,
  res: unknown,
  next?: (err?: unknown) => void,
) => void;

export async function proxyToExpress(
  req: NextRequest,
  app: ExpressHandler,
): Promise<Response> {
  const url = new URL(req.url);

  // ── Build a Node-style IncomingMessage ───────────────────────────────────
  // Express body parsers (express.json, express.urlencoded) and multer all
  // pull bytes from the request as a Readable. For GET/HEAD we hand them an
  // empty stream; for everything else we pipe the Web ReadableStream that
  // NextRequest gives us through Readable.fromWeb (Node 18+).
  const method = req.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD" && req.body !== null;
  const bodyStream = hasBody
    ? Readable.fromWeb(req.body as unknown as Parameters<typeof Readable.fromWeb>[0])
    : Readable.from([]);

  // Express looks at req.headers as a flat record. NextRequest's headers
  // collapse repeated values into a single comma-separated string already, so
  // a flat copy suffices.
  const incomingHeaders: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    incomingHeaders[key] = value;
  });

  // x-forwarded-for is the first hop on Vercel; we surface its leftmost entry
  // as the remote address so middleware that reads req.ip / req.socket gets a
  // sensible value (helmet rate limiting, request logging, etc.).
  const remoteAddress =
    incomingHeaders["x-forwarded-for"]?.split(",")[0]?.trim() ?? "127.0.0.1";

  const fakeSocket = {
    remoteAddress,
    remotePort: 0,
    encrypted: url.protocol === "https:",
    destroy() {},
  };

  const fakeReq = Object.assign(bodyStream, {
    method,
    url: url.pathname + url.search,
    originalUrl: url.pathname + url.search,
    headers: incomingHeaders,
    rawHeaders: Object.entries(incomingHeaders).flatMap(([k, v]) => [k, v]),
    httpVersion: "1.1",
    httpVersionMajor: 1,
    httpVersionMinor: 1,
    connection: fakeSocket,
    socket: fakeSocket,
    complete: false,
    aborted: false,
    // Lets Express routes (see apps/api/src/utils/afterResponse.ts) schedule
    // work that runs after the response is sent without it being dropped
    // when the Vercel function freezes post-response. `after()` is only
    // valid to call within this request's execution scope, which we're
    // still inside of here (proxyToExpress hasn't returned yet).
    runAfterResponse: (fn: () => void | Promise<void>) => {
      after(fn);
    },
  }) as unknown as IncomingMessage;

  // ── Build a streaming-capable fake ServerResponse ────────────────────────
  // The Web Response we return wraps a ReadableStream we feed from Express's
  // res.write/res.end. We resolve the readyPromise the moment headers are
  // committed (writeHead, first write, end, or flushHeaders) so the Response
  // can be constructed with a final status + header set.
  let statusCode = 200;
  let statusMessage = "OK";
  const responseHeaders = new Headers();
  let headersCommitted = false;

  let streamController: ReadableStreamDefaultController<Uint8Array> | null =
    null;
  const responseStream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
    },
  });

  let resolveReady!: () => void;
  const readyPromise = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  const commitHeaders = () => {
    if (!headersCommitted) {
      headersCommitted = true;
      resolveReady();
    }
  };

  const setHeader = (name: string, value: number | string | readonly string[]) => {
    if (Array.isArray(value)) {
      // Set-Cookie can be set multiple times; preserve every value via append.
      responseHeaders.delete(name);
      for (const v of value) responseHeaders.append(name, String(v));
    } else {
      responseHeaders.set(name, String(value));
    }
  };

  const toUint8Array = (chunk: unknown): Uint8Array => {
    if (chunk instanceof Uint8Array) return chunk;
    if (Buffer.isBuffer(chunk)) {
      return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    }
    const str = typeof chunk === "string" ? chunk : String(chunk);
    return new TextEncoder().encode(str);
  };

  const fakeRes: Record<string, unknown> = {
    setHeader(name: string, value: number | string | readonly string[]) {
      setHeader(name, value);
      return fakeRes;
    },
    appendHeader(name: string, value: string | readonly string[]) {
      if (Array.isArray(value)) {
        for (const v of value) responseHeaders.append(name, v);
      } else {
        responseHeaders.append(name, String(value));
      }
      return fakeRes;
    },
    getHeader(name: string) {
      return responseHeaders.get(name) ?? undefined;
    },
    getHeaders() {
      const out: Record<string, string> = {};
      responseHeaders.forEach((v, k) => {
        out[k] = v;
      });
      return out;
    },
    getHeaderNames() {
      const out: string[] = [];
      responseHeaders.forEach((_v, k) => {
        out.push(k);
      });
      return out;
    },
    removeHeader(name: string) {
      responseHeaders.delete(name);
    },
    hasHeader(name: string) {
      return responseHeaders.has(name);
    },
    writeHead(
      code: number,
      messageOrHeaders?: string | Record<string, string | number | readonly string[]>,
      maybeHeaders?: Record<string, string | number | readonly string[]>,
    ) {
      statusCode = code;
      let headersToApply: Record<string, string | number | readonly string[]> | undefined;
      if (typeof messageOrHeaders === "string") {
        statusMessage = messageOrHeaders;
        headersToApply = maybeHeaders;
      } else {
        headersToApply = messageOrHeaders;
      }
      if (headersToApply) {
        for (const [k, v] of Object.entries(headersToApply)) {
          setHeader(k, v as string | number | readonly string[]);
        }
      }
      commitHeaders();
      return fakeRes;
    },
    write(chunk: unknown) {
      commitHeaders();
      if (chunk !== undefined && chunk !== null) {
        streamController!.enqueue(toUint8Array(chunk));
      }
      return true;
    },
    end(chunk?: unknown) {
      commitHeaders();
      if (chunk !== undefined && chunk !== null) {
        streamController!.enqueue(toUint8Array(chunk));
      }
      try {
        streamController!.close();
      } catch (err) {
        // Defensive: already closed (e.g. from an upstream error path) — expected, log to confirm it doesn't fire elsewhere.
        console.warn("[api-adapter/end] stream already closed:", err);
      }
      (fakeRes as { finished?: boolean }).finished = true;
      (fakeRes as { writableEnded?: boolean }).writableEnded = true;
      return fakeRes;
    },
    flushHeaders() {
      commitHeaders();
    },
    // Several Express middlewares attach 'close' / 'finish' / 'drain' / 'error'
    // listeners. We accept and ignore them — the Response stream lifetime is
    // already managed by ReadableStream + the readyPromise.
    on() {
      return fakeRes;
    },
    once() {
      return fakeRes;
    },
    addListener() {
      return fakeRes;
    },
    off() {
      return fakeRes;
    },
    removeListener() {
      return fakeRes;
    },
    removeAllListeners() {
      return fakeRes;
    },
    emit() {
      return false;
    },
    socket: fakeSocket,
    connection: fakeSocket,
    finished: false,
    writableEnded: false,
  };

  Object.defineProperty(fakeRes, "statusCode", {
    get: () => statusCode,
    set: (v: number) => {
      statusCode = v;
    },
    enumerable: true,
  });
  Object.defineProperty(fakeRes, "statusMessage", {
    get: () => statusMessage,
    set: (v: string) => {
      statusMessage = v;
    },
    enumerable: true,
  });
  Object.defineProperty(fakeRes, "headersSent", {
    get: () => headersCommitted,
    enumerable: true,
  });

  // ── Invoke Express ───────────────────────────────────────────────────────
  // Express writes asynchronously, so we don't await the handler call; we
  // await the readyPromise instead. The optional `next` callback only fires
  // when nothing in the chain handled the request OR an error escaped the
  // chain — Express's own errorHandler/notFoundHandler should normally absorb
  // both, but we still emit a 500 if it bubbles to here.
  try {
    app(fakeReq, fakeRes, (err?: unknown) => {
      if (err) {
        if (!headersCommitted) {
          statusCode = 500;
          responseHeaders.set("content-type", "application/json; charset=utf-8");
          commitHeaders();
          streamController!.enqueue(
            new TextEncoder().encode(
              JSON.stringify({
                error: "Internal proxy error",
                message:
                  err instanceof Error ? err.message : String(err),
              }),
            ),
          );
        }
        try {
          streamController!.close();
        } catch (err) {
          // Defensive: already closed — expected after an Express error path. Log to confirm.
          console.warn("[api-adapter/express-error] stream already closed:", err);
        }
      }
    });
  } catch (err: unknown) {
    if (!headersCommitted) {
      statusCode = 500;
      responseHeaders.set("content-type", "application/json; charset=utf-8");
      commitHeaders();
      streamController!.enqueue(
        new TextEncoder().encode(
          JSON.stringify({
            error: "Adapter exception",
            message: err instanceof Error ? err.message : String(err),
          }),
        ),
      );
      try {
        streamController!.close();
      } catch (err) {
        // Defensive: already closed — expected. Log to confirm.
        console.warn("[api-adapter/adapter-exception] stream already closed:", err);
      }
    }
  }

  await readyPromise;

  // Per the Fetch spec, "null body statuses" (101, 103, 204, 205, 304) MUST
  // be constructed with a null body — passing a stream throws:
  //   TypeError: Response constructor: Invalid response status code 304
  // Express commonly emits 304 from its conditional-GET handling (etag /
  // if-none-match) for endpoints like /api/notifications, so this matters.
  const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);
  const body = NULL_BODY_STATUSES.has(statusCode) ? null : responseStream;

  return new Response(body, {
    status: statusCode,
    statusText: statusMessage,
    headers: responseHeaders,
  });
}
