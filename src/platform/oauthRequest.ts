import { nativeFetch } from "./nativeHttp";

/** Bound both headers and JSON-body reads on native HTTP, including older WebViews. */
export async function oauthRequest(
  url: string,
  init: RequestInit = {},
  readJson = true,
): Promise<{
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
}> {
  const abort = new AbortController();
  const cancel = () => abort.abort(init.signal?.reason);
  if (init.signal?.aborted) cancel();
  else init.signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(
    () => abort.abort(new DOMException("Sign-in request timed out.", "TimeoutError")),
    30_000,
  );
  try {
    const response = await nativeFetch(url, { ...init, signal: abort.signal });
    const body = response.ok && readJson ? await response.json() : {};
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new Error("Invalid OAuth response.");
    return { ok: response.ok, status: response.status, body: body as Record<string, unknown> };
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", cancel);
  }
}
