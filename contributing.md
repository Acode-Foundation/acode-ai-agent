# Contributing

Development, extension, and release documentation for Acode AI Agent. For installation and usage, see the [README](readme.md).

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
```

`npm run build` typechecks, bundles for Chrome 90 WebView, rejects Node imports, enforces a 2.7 MB limit on `dist/main.js`, and writes `plugin.zip`.

`npm run dev` serves on port 3000 and rebuilds on change for plugin reload.

The code must stay WebView-compatible: no Node built-ins, child processes, IPC or process `cwd`.

For Elo, copy `.env.example` to the ignored `.env.local` and supply the publisher and Android ad-unit IDs, or set them in the build environment. The iOS ad unit is separate; leave it empty until its App Store property is ready. These are public SDK identifiers. Never ship Elo's server API key. Builds without IDs make no ad requests. The plugin uses Elo’s React-free core. The pinned SDK runs in Acode’s WebView with access to its bridge, DOM and storage. Before updating the SDK, verify that it still reads TCF/GPP synchronously inside `init()`, since the plugin restores shared WebView storage immediately afterward. Review its networking, identifier storage and tracking as well.

For store releases, configure the same public IDs as GitHub Actions variables in the `acode-store` environment. The publish build requires the Android pair. The iOS ID stays optional while the listing is pending.

Elo counts a render when the view mounts and an impression after at least half the view is visible for one continuous second. Tap telemetry uses SDK 0.8.1 with a fresh native consent check and the abort signal supplied by `mountEloAd`. Removing the view, including on consent withdrawal, aborts that signal and stops unsent tap retries; already-aborted taps are dropped. Requests already sent are not cancelled. Opening a link still uses the SDK’s consent-checked click notices. Link opening waits at most one second for a fresh consent check, with progress feedback after 250 ms. If consent cannot be verified, the view stops, pending tracking is cancelled, and the user sees a retry message. The SDK’s `opened` tap field describes an open attempt, not confirmation that the native browser opened successfully.

Before releasing, obtain Elo property approval, enable the placement in the dashboard, authorize the seller in the store-listed developer domain's `app-ads.txt`, and update the app's advertising/privacy disclosures. Confirm Elo's support for WebView app inventory and up to three predefined task topics. Before Elo initialization the plugin checks the host’s AdMob privacy state. A host can include an `iabSignals` snapshot in its `privacyGetState` result to supply TCF/GPP values during SDK initialization. The plugin rechecks native consent after initialization and before sending an ad request, before mounting a card, on resume, and before reporting an impression or following a sponsored link. Overlapping checks for the same card share one pending native read. The next interaction after it settles starts a new read. A definite native denial clears the Elo session and its stored identifiers. If the native check is unavailable, the plugin hides the card until consent can be verified. The current host returns only UMP status. On Android, the plugin falls back to reading UMP’s saved IAB values through Acode’s file API; see the emulator checks below. On iOS, an obtained decision still needs a native signal snapshot. Unknown or unavailable consent skips the request. Validate the CMP flow, child-directed settings, and store disclosures with the privacy owner before enabling live inventory.

Verify on a physical device with an Elo-approved test placement: the health and ad requests from Acode’s origin, the render and impression URLs resolving to the SDK origin (`https://api.elo.ad`), image loading, identifier persistence and removal, render, impression and click-notice delivery, and opening and returning from the native browser. Record the WebView version and use test inventory for tracking checks.

Focused checks: `npx vitest run tests/sponsors.test.ts tests/elo.test.ts tests/sponsorUi.test.ts tests/androidConsent.test.ts`. Live ad fill, device behavior, and publisher onboarding remain separate release checks.

## Extension API

Other Acode plugins can extend the agent once it has loaded:

```js
const runtime = acode.require("acode.ai.agent.runtime");

runtime.registerTool(myPiAgentTool);
runtime.registerTool(myRarelyUsedTool, { exposure: "deferred" });
runtime.registerProvider(myPiProvider);
runtime.registerContext("my-plugin:context", async () => "Extra project context");
runtime.registerFeature({
  id: "my-plugin:feature",
  label: "Feature",
  description: "Declared capability",
  available: ({ workspace }) => Boolean(workspace),
});
runtime.open();
runtime.selectProvider("openrouter");
```

- `registerTool` takes a Pi durable tool (`defineTool` from `@earendil-works/pi-durable`, with `execute(args, api, context)`). It applies to running chats immediately. With `{ exposure: "deferred" }` the tool is loaded through `tool_search` instead of sent with every request; use it for large or rarely needed tools.
- `registerProvider` takes a Pi provider. Open sessions pick it up.
- `registerContext` adds a section to the system prompt, rebuilt before each request and re-sent only when it changes.
- `registerFeature` only records metadata for now and isn't shown in the UI.

Each `register*` call returns a function that unregisters it. Tools have to come from another Acode plugin; the agent never evaluates project JavaScript.

## Sponsored suggestion lifecycle

The plugin requests a single compact 72px strip, 8px above the message input, and renders the format returned by Elo. It has a thumbnail (or a megaphone icon when missing), title, up to two description lines and a separate dismiss control. The rendered card fits its content, with smaller description text and a small Sponsored · Elo label just above it on the left. There is no separate ad below replies. An eligible wait starts the request. The same card stays visible while the answer streams and after the reply finishes, until dismissed, opened or expired. A request already in flight may finish after a fast answer and show that same card. Having text or attachments in the composer hides it to leave more room for writing. Clearing or sending the draft lets the cached card return.

Each chat caches its ad in memory for five minutes from receipt. Later waits reuse that ad. New ads use one shared five-minute view-based cooldown across chats and tabs, with no turn-count requirement. The SDK considers an ad viewed after at least half is visible for one continuous second. Explicit dismissal or a successful link open clears cached ads and suppresses new ads for five minutes, including a quick dismissal before viewability is measured. Consent withdrawal clears the cache. Other failed consent checks may discard a card without starting a new cooldown.

Only an eligible wait can initiate a new request. A long wait can replace an expired card once the cooldown permits it. After a reply finishes, expiry removes the existing card without requesting a replacement. All request attempts share a minimum 30-second interval, including successful requests before an impression is measured. Viewed or explicitly dismissed ads use the longer five-minute cooldown. A different waiting turn resumes automatically after the shared request slot and cooldown become available; the failed turn is not retried. Stopped or failed runs, typing, a chat switch, an obscured conversation or backgrounding cancel pending requests. Restored history alone never initiates requests. Ads are not saved in the transcript.

Free users with device consent see a short opt-in during their first visible wait, with privacy details in an Acode dialog. The opt-in sits above the input and, once at least half visible, stays in that chat until answered. Deleting that chat frees the unanswered offer for another eligible wait. Allowing suggestions makes the current wait eligible immediately. Frequency state lasts for the plugin session. The pinned Elo SDK aborts ad fetches after three seconds, and native consent reads also have a three-second timeout. When upgrading the SDK, run `npm test` and verify the sponsor layout on a device: disclosure placement and failed-image fallback depend on its DOM structure.

## Android consent file fallback

When `admob.privacy.getState()` omits `iabSignals`, Android builds read `<cordova.file.applicationStorageDirectory>/shared_prefs/<BuildInfo.packageName>_preferences.xml` using `acode.require("fsOperation")`. No native changes, new CMP account, hosted page, storage permission prompt, or preference writes are needed. The parser returns only the five Elo IAB fields and `IABTCF_PurposeConsents`; unrelated preferences are discarded and never logged.

Each check compares two fresh file reads and rechecks native eligibility, under the existing three-second deadline. Missing or invalid files, inconsistent reads, missing GDPR applicability, incomplete required signals, or missing Purpose 1 permission block ads. Refusal clears the Elo identifier even when UMP still permits limited ads. Existing native snapshots, including an empty object, are authoritative and skip the file fallback: missing entries are cleared rather than filled from disk. An empty snapshot with `obtained` is unavailable; with `notRequired` and `canRequestAds=true`, the existing native path permits a request with all five signals absent. Hosts must omit `iabSignals` to request the Android fallback instead of returning a placeholder `{}`. The native snapshot contract requires GPP string and section IDs together when either is present; incomplete pairs are unavailable. iOS does not attempt Android file access.

This is a compatibility fallback, not an atomic SharedPreferences API: Android can update memory before flushing the file, and two matching reads cannot prove a flush has completed. The emulator checks verify decisions after the UMP callback, not every possible disk-write race. Confirm Elo/vendor coverage in the app’s UMP configuration before enabling live inventory; a readable TC string is not consent for every vendor. GPP is forwarded when present, and a missing GPP field is never fabricated. A GPP-only file without explicit GDPR applicability remains unavailable. Purpose 1 validation does not imply permission for every advertising purpose or vendor. The pinned Elo web SDK forwards the strings and checks for a missing TC string; it does not decode full purpose/vendor or GPP choices in that check. Full enforcement must be confirmed with Elo’s backend, not assumed to happen in the web SDK.

Eligibility is based on the supplied signals, not an EEA-only region restriction. Both EEA consent and explicit non-EEA applicability were verified. A file containing only GPP, with no explicit GDPR applicability, stays blocked; US GPP-only support is not claimed. GPP itself also supports EU TCF, so its presence is not a substitute for `IABTCF_gdprApplies`.

### Emulator regression check

Run this check before releasing changes to consent handling or upgrading Acode/UMP support, and record the tested versions. CI verifies packaging and unit behavior; it does not run this emulator check.

Use a **disposable Android emulator** with a debuggable free Acode APK and Google's Publisher Test Ads UMP configuration. Finish Acode startup first. This test resets that emulator's UMP consent, accepts/refuses test forms, and temporarily changes the plugin opt-in. The script itself does not write native preference files or alter Acode's native code; UMP persists the test choices made through its forms.

Forward Acode's WebView debugging socket (replace `<pid>` with the result of `adb -s emulator-5580 shell pidof com.foxdebug.acodefree`):

```sh
adb -s emulator-5580 forward tcp:9555 localabstract:webview_devtools_remote_<pid>
node tests/e2e/androidConsent.mjs
```

Run from the repository root with Node 22 or newer. Set `CDP_PORT` if using a different forwarded port. The script uses the real UMP dialog, native state, file bridge, plugin consent code, and pinned Elo SDK. Elo HTTP responses are intercepted locally, so it does not produce live Elo ad requests or impressions. It verifies unknown-state blocking, accepted TC/Additional Consent forwarding, shared-storage restoration, withdrawal/identifier removal, re-consent, and the non-EEA flow. It also reports the real UMP file keys and purpose-bit length to expose format changes.

Validated on Android 15, WebView 124, and the existing Acode 1.13.6 debug APK (version code 1013), containing UMP 4.0.0 (verified from the APK’s DEX metadata). EEA acceptance produced a real 712-character TC string and an **11-bit** `IABTCF_PurposeConsents` value; refusal left native `canRequestAds` true but the plugin correctly denied advertising. The non-EEA test persisted `IABTCF_gdprApplies=0` with no TC string and passed the consent-to-SDK flow. Do not require 24 purpose bits in the preference field: the [IAB in-app specification](https://github.com/InteractiveAdvertisingBureau/GDPR-Transparency-and-Consent-Framework/blob/master/TCFv2/IAB%20Tech%20Lab%20-%20CMP%20API%20v2.md#in-app-details) defines indexed binary consent values without that fixed-length requirement. Live US GPP collection, production vendor coverage, real Elo ad fill, and iOS consent remain unverified. GPP forwarding and malformed/missing-file behavior have unit coverage.

The inspected Acode privacy bridge exposes only `disabled`, `eea`, and `notEea` debug geographies. It does not expose UMP’s regulated-US-state test setting, so the non-EEA test is not a US allow/opt-out test. That flow still needs a suitable device/network or a host build exposing the required test geography. No native host changes were made.
