// Run only against a disposable emulator with a debuggable free Acode build.
// Forward its webview_devtools_remote_<pid> socket to CDP_PORT (default 9555).
// The UMP form labels/classes are private DOM, verified with UMP 4.0.0 / WebView 124.
// Re-run before releases and after Acode, UMP, or WebView upgrades; see contributing.md.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import { CdpUnavailableError, waitForAcode } from "./startup.mjs";

const endpoint = `http://127.0.0.1:${process.env.CDP_PORT || 9555}`;
const screenshots = process.env.E2E_SCREENSHOTS;
const pages = async (timeout = 10_000) => {
  try {
    const response = await fetch(`${endpoint}/json/list`, { signal: AbortSignal.timeout(timeout) });
    if (!response.ok) throw new Error(`CDP target list returned HTTP ${response.status}`);
    return await response.json();
  } catch (cause) {
    throw new CdpUnavailableError(`Cannot read CDP targets at ${endpoint}: ${cause.message}`, {
      cause,
    });
  }
};
console.log("Waiting for Acode startup; finish any permission or update prompts first.");
// The splash disappears before the host gathers consent. window.ad is assigned only
// after its AdMob initialization finishes, so startup consent collection finishes first.
const { main, environment } = await waitForAcode(pages, evaluate);
assert(
  environment.debug && environment.emulator,
  "This test resets consent: use a disposable debug emulator",
);
console.log("Environment:", environment);
const run = (expression) => evaluate(main, expression);

const bundle = await build({
  stdin: {
    contents: `export {readSponsorConsent} from './src/suggestions/consent';
      export {readAndroidConsentSignals} from './src/suggestions/androidConsent';
      export {loadSponsor} from './src/suggestions/elo';
      export {setSponsorConsent,clearSponsorIdentity} from './src/suggestions/preferences';`,
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  write: false,
  format: "iife",
  globalName: "globalThis.consentE2E",
  target: "chrome90",
  define: {
    ELO_PUBLISHER_ID: '"emulator-test"',
    ELO_AD_UNIT_ID: '"emulator-test"',
    ELO_IOS_AD_UNIT_ID: '""',
  },
});
await run(bundle.outputFiles[0].text);
await run(`(() => {
  window.consentTest = {fetch:window.fetch,previous:localStorage.getItem('acode.ai-agent.sponsors.v1'),requests:[],done:null};
  window.fetch = async (url, options) => {
    if (!String(url).startsWith('https://api.elo.ad/')) return consentTest.fetch(url, options);
    consentTest.requests.push({url:String(url),body:options?.body ? JSON.parse(options.body) : null});
    if (String(url).endsWith('/request')) return new Response(JSON.stringify({request_id:'emulator-test',ad:{title:'Consent test',description:'Local test response',click_url:'https://example.com',render_url:'/test/render',impression_url:'/test/impression'}}),{status:200,headers:{'Content-Type':'application/json'}});
    return new Response(null,{status:204});
  };
  consentE2E.clearSponsorIdentity();
  consentE2E.setSponsorConsent('allowed');
})()`);
try {
  // Close any startup test form before resetting UMP. No native preferences are written by the test.
  await clickConsent("Do not consent", false);
  await run("admob.privacy.resetForTesting()");
  assert.equal((await probe()).status, "unavailable");
  assert.equal(await loadAd(), false);
  assert.equal(await run("consentTest.requests.length"), 0);
  console.log("PASS: unknown consent blocks Elo initialization and network requests");

  await startForm("gatherConsent({debugGeography:'eea'})");
  await clickConsent("Consent", true, "consent-form");
  await completed();
  const accepted = await probe();
  assert.equal(accepted.status, "allowed");
  assert(accepted.tcLength > 0 && accepted.gdpr === "1");
  const shape = await run(`(async()=>{
    const s = await consentE2E.readAndroidConsentSignals();
    const purposes = s.IABTCF_PurposeConsents ?? "";
    const interests = s.IABTCF_PurposeLegitimateInterests;
    return {
      keys: Object.keys(s),
      purposeLength: purposes.length,
      purposeBitsValid: /^[01]+$/.test(purposes),
      purposeBits: purposes,
      liPresent: interests != null,
      liLength: interests?.length,
      liBits: interests ?? "",
      liBitsValid: /^[01]+$/.test(interests ?? ""),
    };
  })()`);
  console.log("UMP EEA file shape:", shape);
  assert.equal(
    shape.purposeBitsValid,
    true,
    "UMP preference shape changed: expected a nonempty binary purpose string",
  );
  assert.equal(shape.liPresent, true, "UMP did not persist the legitimate-interest key");
  assert.equal(
    shape.liBitsValid,
    true,
    "UMP preference shape changed: expected a nonempty LI bit string",
  );
  // Match the local gate: Purpose 1 needs consent; Purposes 2/7 also accept LI.
  assert.equal(shape.purposeBits[0], "1", "Purpose 1 consent missing after Consent");
  for (const purpose of [2, 7]) {
    assert(
      shape.purposeBits[purpose - 1] === "1" || shape.liBits[purpose - 1] === "1",
      `Purpose ${purpose} consent or legitimate interest missing after Consent`,
    );
  }
  assert.equal(await loadAd(), true);
  const request = await run(`(async () => {
    const native = await consentE2E.readAndroidConsentSignals();
    const body = consentTest.requests.find(r=>r.url.endsWith('/request')).body;
    return {tcMatches:body.consent.tcf_string===native.IABTCF_TCString,acMatches:body.consent.addtl_consent===native.IABTCF_AddtlConsent,restored:localStorage.getItem('IABTCF_TCString')===null,identifier:!!localStorage.getItem('elo_visitor_id')};
  })()`);
  assert.equal(request.tcMatches, true);
  assert.equal(request.acMatches, true);
  assert.equal(request.restored, true);
  assert.equal(request.identifier, true);
  console.log("PASS: real UMP -> file API -> plugin -> pinned Elo SDK request", accepted);

  for (const [interests, expected] of [
    [[2, 7], "allowed"],
    [[7], "denied"],
    [[2], "denied"],
    [[], "denied"],
  ]) {
    await startForm("showOptions()");
    await clickConsent("Manage options");
    await choosePurposes([1], interests);
    const preview =
      interests.length === 2 ? "li-only" : interests[0] === 7 ? "purpose-2-refused" : undefined;
    await clickConsent("Confirm choices", true, preview);
    await completed();
    const bits = await run(`(async()=>{
      const s = await consentE2E.readAndroidConsentSignals();
      return {consents:s.IABTCF_PurposeConsents, interests:s.IABTCF_PurposeLegitimateInterests};
    })()`);
    assert.match(bits.consents, /^10{6,}$/);
    for (const purpose of [2, 7])
      assert.equal(bits.interests[purpose - 1], interests.includes(purpose) ? "1" : "0");
    assert.equal((await probe()).status, expected);
    const before = await run("consentTest.requests.length");
    assert.equal(await loadAd(), expected === "allowed");
    if (expected === "denied") {
      assert.equal(await run("consentTest.requests.length"), before);
      assert.equal(await run("localStorage.getItem('elo_visitor_id')"), null);
    }
    console.log(`PASS: Purpose 1 consent + LI for [${interests}] -> ${expected}`, bits);
  }
  // Restore an allowed request so withdrawal below must clear an existing identifier.
  await startForm("showOptions()");
  await clickConsent("Consent");
  await completed();
  assert.equal(await loadAd(), true);

  await startForm("showOptions()");
  const before = await run("consentTest.requests.length");
  await clickConsent("Do not consent");
  await completed();
  assert.equal((await probe()).status, "denied");
  assert.equal(await loadAd(), false);
  assert.equal(await run("consentTest.requests.length"), before);
  assert.equal(await run("localStorage.getItem('elo_visitor_id')"), null);
  console.log("PASS: withdrawal blocks new requests and removes the Elo identifier");

  await startForm("showOptions()");
  await clickConsent("Consent");
  await completed();
  assert.equal((await probe()).status, "allowed");
  assert.equal(await loadAd(), true);
  console.log("PASS: consent can be granted again without reloading the plugin");

  await run("admob.privacy.resetForTesting()");
  await startForm("gatherConsent({debugGeography:'notEea'})");
  await completed();
  const nonEea = await probe();
  assert.equal(nonEea.gdpr, "0", "Non-EEA UMP did not persist explicit GDPR applicability");
  assert.equal(nonEea.status, "allowed");
  assert.equal(await loadAd(), true);
  console.log("PASS: non-EEA UMP -> file API -> Elo", nonEea);
} finally {
  await run(`(() => {
    consentE2E.setSponsorConsent('declined');
    if(consentTest.previous===null)localStorage.removeItem('acode.ai-agent.sponsors.v1');
    else localStorage.setItem('acode.ai-agent.sponsors.v1',consentTest.previous);
    window.fetch=consentTest.fetch;
    delete window.consentTest;
    delete window.consentE2E;
  })()`);
}

async function probe() {
  return run(
    `(async () => { const result=await consentE2E.readSponsorConsent(new AbortController().signal);return {status:result.status,gdpr:result.signals?.[0],tcLength:result.signals?.[1]?.length??0}; })()`,
  );
}
async function loadAd() {
  return run(
    "(async()=>!!(await consentE2E.loadSponsor(['Web development'],new AbortController().signal,{maxHeight:72,maxWidth:320})))()",
  );
}
async function startForm(method) {
  await run(
    `(() => {consentTest.done=null;admob.privacy.${method}.then(value=>consentTest.done={value},error=>consentTest.done={error:String(error)});})()`,
  );
}
async function completed() {
  const result = await until(() => run("consentTest.done"));
  assert(!result.error, result.error);
  return result.value;
}
async function clickConsent(label, required = true, preview) {
  const capture = Boolean(screenshots && preview);
  const button = (click) => `(() => {
    if (!document.body.textContent.includes('Publisher Test Ads')) return false;
    const button=[...document.querySelectorAll('button')].find(b=>b.innerText.trim()===${JSON.stringify(label)}&&b.getClientRects().length);
    if(button && ${click})button.click();return !!button;
  })()`;
  const attempt = async () => {
    for (const page of await pages()) {
      let found;
      try {
        if (page.url !== "about:blank" || !JSON.parse(page.description).attached) continue;
        found = await evaluate(page, button(!capture));
      } catch {
        /* A closed UMP WebView can disappear during enumeration. */
        continue;
      }
      if (!found) continue;
      if (!capture) return true;
      await capturePreview(page, preview);
      return evaluate(page, button(true));
    }
    return false;
  };
  return required ? until(attempt, `UMP button: ${label}`) : attempt();
}
async function capturePreview(page, name) {
  const purpose = name === "li-only" ? 7 : name === "purpose-2-refused" ? 2 : undefined;
  if (purpose) {
    await evaluate(
      page,
      `document.querySelector('input.purpose[data-id="${purpose}"]')?.scrollIntoView({block:'center'})`,
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  mkdirSync(screenshots, { recursive: true });
  const file = path.join(screenshots, `${name}.png`);
  writeFileSync(
    file,
    execFileSync(
      "adb",
      ["-s", process.env.ANDROID_SERIAL || "emulator-5580", "exec-out", "screencap", "-p"],
      { timeout: 10_000 },
    ),
  );
  console.log(`PREVIEW: ${file}`);
  await new Promise((resolve) => setTimeout(resolve, 6000));
}
async function choosePurposes(consents, interests) {
  await until(async () => {
    for (const page of await pages()) {
      if (page.url !== "about:blank" || !JSON.parse(page.description).attached) continue;
      const changed = await evaluate(
        page,
        `(() => {
          if (!document.body.textContent.includes('Publisher Test Ads') || !document.body.innerText.includes('Manage your data')) return false;
          const inputs = [...document.querySelectorAll('input.purpose')].filter(input=>input.getClientRects().length);
          if (!inputs.length) return false;
          const consents = ${JSON.stringify(consents)}, interests = ${JSON.stringify(interests)};
          for (const input of inputs) {
            const granted = input.classList.contains('fc-preference-consent') ? consents : interests;
            if (input.checked !== granted.includes(Number(input.dataset.id))) input.click();
          }
          return true;
        })()`,
      );
      if (changed) return true;
    }
    return false;
  });
}
async function until(check, description = "Google's test consent form/callback", timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw Error(`Timed out waiting for ${description}`);
}
async function evaluate(page, expression, timeout = 10_000) {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(
      () => finish(new CdpUnavailableError("CDP evaluation timed out")),
      timeout,
    );
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      if (error) reject(error);
      else resolve(value);
    };
    ws.onerror = () => finish(new CdpUnavailableError("WebView connection failed"));
    ws.onclose = () =>
      finish(new CdpUnavailableError("WebView connection closed before responding"));
    ws.onopen = () =>
      ws.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      );
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== 1) return;
      const error = message.error || message.result?.exceptionDetails;
      const transient =
        message.error &&
        /context.*destroyed|cannot find context|target.*closed|session.*closed/i.test(
          message.error.message,
        );
      finish(
        error ? new (transient ? CdpUnavailableError : Error)(JSON.stringify(error)) : null,
        message.result?.result?.value,
      );
    };
  });
}
