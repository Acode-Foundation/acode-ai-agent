// Run only against a disposable emulator with a debuggable free Acode build.
// Forward its webview_devtools_remote_<pid> socket to CDP_PORT (default 9555).
import assert from "node:assert/strict";
import { build } from "esbuild";

const endpoint = `http://127.0.0.1:${process.env.CDP_PORT || 9555}`;
const pages = () => fetch(`${endpoint}/json/list`).then((response) => response.json());
const main = (await pages()).find((page) => page.url === "https://localhost/index.html");
assert(main, "Open Acode and forward its WebView debugging socket first");
const run = (expression) => evaluate(main, expression);
const environment = await run(
  "({debug:BuildInfo.debug,emulator:device.isVirtual,version:BuildInfo.version,code:BuildInfo.versionCode,webview:navigator.userAgent})",
);
assert(
  environment.debug && environment.emulator,
  "This test resets consent: use a disposable debug emulator",
);
console.log("Environment:", environment);

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
  await clickConsent("Consent");
  await completed();
  const accepted = await probe();
  assert.equal(accepted.status, "allowed");
  assert(accepted.tcLength > 0 && accepted.gdpr === "1");
  const shape = await run(
    "(async()=>{const s=await consentE2E.readAndroidConsentSignals();return {keys:Object.keys(s),purposeLength:s.IABTCF_PurposeConsents?.length,purposeBitsValid:/^[01]+$/.test(s.IABTCF_PurposeConsents??'')}})()",
  );
  assert.equal(
    shape.purposeBitsValid,
    true,
    "UMP preference shape changed: expected a nonempty binary purpose string",
  );
  console.log("UMP EEA file shape:", shape);
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
async function clickConsent(label, required = true) {
  const attempt = async () => {
    for (const page of await pages()) {
      try {
        if (page.url !== "about:blank" || !JSON.parse(page.description).attached) continue;
        const clicked = await evaluate(
          page,
          `(() => {
          if (!document.body.innerText.includes('Publisher Test Ads')) return false;
          const button=[...document.querySelectorAll('button')].find(b=>b.innerText.trim()===${JSON.stringify(label)}&&b.getClientRects().length);
          if(button)button.click();return !!button;
        })()`,
        );
        if (clicked) return true;
      } catch {
        /* A closed UMP WebView can disappear during enumeration. */
      }
    }
    return false;
  };
  return required ? until(attempt) : attempt();
}
async function until(check) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw Error("Timed out waiting for Google's test consent form/callback");
}
async function evaluate(page, expression) {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(Error("CDP evaluation timed out")), 10000);
    const finish = (error, value) => {
      clearTimeout(timer);
      ws.close();
      if (error) reject(error);
      else resolve(value);
    };
    ws.onerror = () => finish(Error("WebView connection failed"));
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
      finish(error ? Error(JSON.stringify(error)) : null, message.result?.result?.value);
    };
  });
}
