/** Shared browser and native callback page; no remote assets are needed. */
export function loopbackPage(
  title: string,
  message: string,
  returnUri: string,
  script = "",
  state: "loading" | "ready" | "error" = "ready",
): { html: string; policy: string } {
  const nonce = crypto.randomUUID();
  const policy = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; worker-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>ChatGPT sign-in · Acode</title><style nonce="${nonce}">
*{box-sizing:border-box}body{margin:0;min-height:100vh;min-height:100svh;display:grid;place-items:center;padding:24px;background:#101318;color:#f1f4f8;font:16px/1.6 system-ui,sans-serif}main{width:min(100%,420px);padding:32px;border:1px solid #2c3340;border-radius:24px;background:#191e27;box-shadow:0 16px 64px #0003}.brand{margin:0 0 24px;color:#9cb9ec;font-size:13px;font-weight:650;letter-spacing:.05em}#indicator{width:48px;height:48px;margin-bottom:20px;border-radius:50%;background:#263b32;color:#94e4b5;display:grid;place-items:center;font-size:24px}#indicator[data-state="ready"]:before{content:'✓'}#indicator[data-state="error"]{background:#423029;color:#ffc19d}#indicator[data-state="error"]:before{content:'!'}#indicator[data-state="loading"]{background:none;border:3px solid #303b50;border-top-color:#98bcff;animation:spin 1s linear infinite}h1{margin:0 0 12px;font-size:26px;line-height:1.25;letter-spacing:-.02em}#status{margin:0;color:#bbc5d4}a:not([hidden]){display:block;margin-top:28px;padding:13px 18px;border-radius:12px;background:#9cbfff;color:#111c31;text-align:center;text-decoration:none;font-weight:650}a:focus-visible{outline:3px solid #fff;outline-offset:4px}.hint{margin:18px 0 0;font-size:13px;color:#929eb0}@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){#indicator{animation:none!important}}@media(prefers-color-scheme:light){body{background:#f3f5f9;color:#182135}main{background:#fff;border-color:#dce2ec}.brand{color:#365c98}#status{color:#526078}.hint{color:#66758c}}
</style></head><body><main><p class="brand">Acode AI Agent</p><div id="indicator" data-state="${state}" aria-hidden="true"></div><h1 id="title">${title}</h1><p id="status" role="status" aria-live="polite">${message}</p><a id="return" href="${returnUri}"${state === "loading" ? " hidden" : ""}>Return to Acode</a><p class="hint">${state === "loading" ? "This will only take a moment." : "If Acode does not open automatically, tap the button."}</p></main>${script ? `<script nonce="${nonce}">${script}</script>` : ""}</body></html>`;
  return { html, policy };
}

/** Chrome owns the callback after setup; initial page/worker loading still needs Acode. */
export function browserLoopbackPages(
  authorization: string,
  state: string,
  returnUri: string,
  expiresAt: number,
): { start: string; worker: string; policy: string; startPolicy: string } {
  const json = (value: unknown) => JSON.stringify(value).replaceAll("<", "\\u003c");
  const callback = loopbackPage(
    "You're signed in",
    "Returning to Acode to finish connecting your ChatGPT account…",
    returnUri,
    `(${returnToAcode.toString()})(${json(returnUri)});`,
  );
  const start = loopbackPage(
    "Connecting to ChatGPT",
    "Preparing your secure sign-in…",
    returnUri,
    `(${prepareBrowser.toString()})(${json(authorization)},${json(state)});`,
    "loading",
  );
  return {
    policy: callback.policy,
    startPolicy: start.policy,
    start: start.html,
    worker: `self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(event.request.method!=='GET'||url.pathname!=='/auth/callback')return;
  const states=url.searchParams.getAll('state');
  if(states.length!==1||states[0]!==${json(state)}||Date.now()>${expiresAt}){
    event.respondWith(new Response('This sign-in callback is invalid or expired.',{status:400}));return;
  }
  event.respondWith(new Response(${json(callback.html)},{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Security-Policy':${json(callback.policy)}}}));
  event.waitUntil(self.registration.unregister());
});`,
  };
}

// These functions are serialized into browser scripts; keep them self-contained.
async function prepareBrowser(authorization: string, state: string) {
  let finished = false;
  let registration: ServiceWorkerRegistration | undefined;
  let worker: ServiceWorker | undefined;
  let changed: (() => void) | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        const registered = await navigator.serviceWorker.register(
          `/auth/sw.js?state=${encodeURIComponent(state)}`,
          { scope: "/auth/", updateViaCache: "none" },
        );
        if (finished) {
          await registered.unregister();
          return;
        }
        registration = registered;
        worker =
          registration.installing ?? registration.waiting ?? registration.active ?? undefined;
        if (!worker) throw new Error("Browser callback could not start.");
        if (worker.state !== "activated")
          await new Promise<void>((resolve, reject) => {
            changed = () => {
              if (worker!.state === "activated") resolve();
              else if (worker!.state === "redundant")
                reject(new Error("Browser callback could not start."));
            };
            worker!.addEventListener("statechange", changed);
            changed();
          });
      })(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Browser callback preparation timed out.")),
          15_000,
        );
      }),
    ]);
    location.replace(authorization);
  } catch {
    void registration?.unregister().catch(() => undefined);
    document.getElementById("title")!.textContent = "Sign-in could not start";
    document.getElementById("indicator")!.dataset.state = "error";
    document.getElementById("status")!.textContent =
      "Return to Acode and try signing in again using Chrome.";
    document.getElementById("return")!.hidden = false;
  } finally {
    finished = true;
    clearTimeout(timeout);
    if (worker && changed) worker.removeEventListener("statechange", changed);
  }
}

function returnToAcode(returnUri: string) {
  const query = new URLSearchParams(location.search);
  history.replaceState(null, "", location.pathname);
  const suffix = returnUri.indexOf("#Intent;");
  const target = returnUri.slice(0, suffix) + "?" + query.toString() + returnUri.slice(suffix);
  document.getElementById("return")!.setAttribute("href", target);
  if (query.has("error")) {
    document.getElementById("title")!.textContent = "Sign-in cancelled";
    document.getElementById("indicator")!.dataset.state = "error";
  }
  document.getElementById("status")!.textContent = query.has("error")
    ? "Sign-in was not approved. Return to Acode to try again."
    : "Sign-in approved. Return to Acode to finish connecting.";
  // Chrome can require a tap for an intent; retain the button if automatic opening is blocked.
  try {
    location.replace(target);
  } catch {}
}
