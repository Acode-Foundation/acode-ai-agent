import { browserLoopbackPages, loopbackPage } from "./browserLoopback";

type CallbackRequest = {
  requestId: string;
  method: string;
  path: string;
  query?: string;
};
type NativeServer = {
  stop(success: () => void, failure: (error: string) => void): void;
  send(id: string, response: unknown, success: () => void, failure: (error: string) => void): void;
  setOnRequestHandler(
    handler: (request: CallbackRequest) => void,
    failure: (error: string) => void,
  ): void;
};
type CreateServer = (
  port: number,
  success: () => void,
  failure: (error: string) => void,
) => NativeServer;

export type LoopbackAuthorization = { code: string; clientId: string };

/** Starts a scoped callback listener using Acode's server API. */
export async function startLoopbackOAuth(
  state: string,
  clientId?: string,
  signal?: AbortSignal,
): Promise<{
  redirectUri: string;
  browserUrl(authorization: string): string;
  result: Promise<LoopbackAuthorization>;
  close(): Promise<void>;
}> {
  signal?.throwIfAborted();
  const create = (globalThis as { CreateServer?: CreateServer }).CreateServer;
  if (!create)
    throw new Error(
      "ChatGPT browser sign-in is unavailable in this environment. Use Codex device-code sign-in.",
    );
  // Avoid the host's preview port and the well-known Codex/CLI OAuth port.
  const port = 49152 + (crypto.getRandomValues(new Uint16Array(1))[0]! % 16384);
  const redirectUri = `http://127.0.0.1:${port}/auth/callback`;
  const android =
    (globalThis as { cordova?: { platformId?: string } }).cordova?.platformId === "android";
  const appPackage = globalThis.BuildInfo?.packageName;
  const target =
    appPackage && /^[A-Za-z][\w]*(?:\.[A-Za-z][\w]*)+$/.test(appPackage)
      ? `package=${appPackage};`
      : "";
  const returnUri = android
    ? `intent://ai-agent/oauth/chatgpt#Intent;scheme=acode;${target}end`
    : "acode://ai-agent/oauth/chatgpt";
  let server!: NativeServer;
  let resolve!: (value: LoopbackAuthorization) => void;
  let reject!: (error: Error) => void;
  let settled = false;
  let closed = false;
  let pages: ReturnType<typeof browserLoopbackPages> | undefined;
  const intent = (globalThis as { acode?: typeof acode }).acode?.require("intent");
  const onReturn = (event: Acode.IntentEvent & { url?: string }) => {
    if (event.module !== "ai-agent" || event.action !== "oauth") return;
    let callback: URL;
    try {
      callback = new URL(event.url ?? `acode://ai-agent/oauth/${event.value}`);
    } catch {
      return;
    }
    if (
      callback.protocol !== "acode:" ||
      callback.host !== "ai-agent" ||
      callback.pathname !== "/oauth/chatgpt" ||
      callback.username ||
      callback.password ||
      callback.hash
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    // Only a callback bound to the pending flow can authorize the account.
    accept(callback.searchParams);
  };
  const result = new Promise<LoopbackAuthorization>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // A startup failure or cancellation can happen before the caller awaits result.
  void result.catch(() => undefined);
  const fail = (error: Error) => {
    if (settled) return;
    settled = true;
    reject(error);
  };
  const accept = (query: URLSearchParams): LoopbackAuthorization | undefined => {
    if (
      settled ||
      Date.now() > expiresAt ||
      signal?.aborted ||
      query.getAll("state").length !== 1 ||
      query.get("state") !== state
    )
      return;
    if (
      ["access_token", "refresh_token", "id_token", "client_secret"].some((key) => query.has(key))
    )
      return;
    if (query.has("error")) {
      fail(new Error("ChatGPT authorization was denied. Try again."));
      return;
    }
    const codes = query.getAll("code");
    const ids = query.getAll("client_id");
    const issued = ids[0] ?? clientId;
    if (
      codes.length !== 1 ||
      !codes[0] ||
      codes[0].length > 4096 ||
      ids.length > 1 ||
      !issued ||
      !/^[A-Za-z0-9_-]{1,256}$/.test(issued) ||
      issued === "dynamic_agent_client" ||
      (clientId && issued !== clientId)
    )
      return;
    const authorization = { code: codes[0], clientId: issued };
    settled = true;
    resolve(authorization);
    return authorization;
  };
  const expiresAt = Date.now() + 10 * 60_000;
  const abort = () => fail(new DOMException("Sign-in cancelled", "AbortError"));
  const timer = setTimeout(
    () => fail(new Error("ChatGPT sign-in expired. Try again.")),
    10 * 60_000,
  );
  signal?.addEventListener("abort", abort, { once: true });
  const close = async () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    intent?.removeHandler?.(onReturn);
    if (!settled) fail(new DOMException("Sign-in cancelled", "AbortError"));
    if (server) await new Promise<void>((done) => server.stop(done, () => done()));
  };
  try {
    intent?.addHandler?.(onReturn);
    await Promise.race([
      new Promise<void>((yes, no) => {
        server = create(port, yes, (message) =>
          no(new Error(message || "Could not start ChatGPT sign-in.")),
        );
      }),
      result,
    ]);
    signal?.throwIfAborted();
    server.setOnRequestHandler(
      (request) => {
        if (
          pages &&
          request.method === "GET" &&
          ["/auth/start", "/auth/sw.js"].includes(request.path) &&
          new URLSearchParams(request.query ?? "").get("state") === state
        ) {
          const worker = request.path === "/auth/sw.js";
          server.send(
            request.requestId,
            {
              status: 200,
              body: worker ? pages.worker : pages.start,
              headers: {
                "Content-Type": worker ? "application/javascript" : "text/html; charset=utf-8",
                "Cache-Control": "no-store",
                "Referrer-Policy": "no-referrer",
                "Content-Security-Policy": worker
                  ? "default-src 'none'; script-src 'self'; base-uri 'none'"
                  : pages.startPolicy,
                "X-Content-Type-Options": "nosniff",
              },
            },
            () => {},
            () => {},
          );
          return;
        }
        let status = 400;
        let message = "Invalid sign-in callback. Return to the original sign-in page.";
        let authorization: LoopbackAuthorization | undefined;
        if (request.method !== "GET" || request.path !== "/auth/callback") status = 404;
        else {
          const query = new URLSearchParams(request.query ?? "");
          const denied =
            !settled &&
            query.getAll("state").length === 1 &&
            query.get("state") === state &&
            query.has("error");
          authorization = accept(query);
          if (denied) {
            message = "ChatGPT was not connected. Return to Acode to try again.";
          } else if (authorization) {
            status = 200;
            message = "Sign-in approved. Return to Acode to finish connecting.";
          }
        }
        const page = loopbackPage(
          authorization ? "You're signed in" : "Sign-in not completed",
          message,
          returnUri,
          "",
          authorization ? "ready" : "error",
        );
        server.send(
          request.requestId,
          {
            status,
            body: page.html,
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-store",
              "Referrer-Policy": "no-referrer",
              "Content-Security-Policy": page.policy,
            },
          },
          () => {},
          () => {},
        );
      },
      (message) => fail(new Error(message || "ChatGPT callback failed.")),
    );
    return {
      redirectUri,
      result,
      close,
      browserUrl(authorization) {
        if (!android || !intent?.addHandler) return authorization;
        const url = new URL(authorization);
        if (url.origin !== "https://auth.openai.com")
          throw new Error("Invalid ChatGPT sign-in URL.");
        pages = browserLoopbackPages(url.href, state, returnUri, expiresAt);
        return `http://127.0.0.1:${port}/auth/start?state=${encodeURIComponent(state)}`;
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
