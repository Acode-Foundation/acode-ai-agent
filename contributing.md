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

Before releasing, obtain Elo property approval, enable the placement in the dashboard, authorize the seller in the store-listed developer domain's `app-ads.txt`, and update the app's advertising/privacy disclosures. Confirm Elo's support for WebView app inventory and up to three predefined task topics. Before Elo initialization the plugin checks the host’s AdMob privacy state. A host can include an `iabSignals` snapshot in its `privacyGetState` result to supply TCF/GPP values during SDK initialization. The plugin rechecks native consent after initialization and before sending an ad request, before mounting a card, on resume, and before reporting an impression or following a sponsored link. Overlapping checks for the same card share one pending native read. The next interaction after it settles starts a new read. A definite native denial clears the Elo session and its stored identifiers. If the native check is unavailable, the plugin hides the card until consent can be verified. Before mounting the SDK view, bridge or invalid reads are retried twice so a transient bridge or file race does not lose an ad Elo already served. An already-mounted view stops immediately when a recheck is unavailable; a later focus or resume can verify consent and mount it again. The current host returns only UMP status. On Android, the plugin falls back to reading UMP’s saved IAB values through Acode’s file API; see the emulator checks below. On iOS, an obtained decision still needs a native signal snapshot. Unknown or unavailable consent skips the request. Validate the CMP flow, child-directed settings, and store disclosures with the privacy owner before enabling live inventory.

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

The plugin requests a single compact 72px strip, 8px above the message input, and renders the format returned by Elo. It has a thumbnail (or a megaphone icon when missing), title, up to two description lines and a separate dismiss control. The rendered card fits its content, with smaller description text and a small Sponsored · Elo label just above it on the left. There is no separate ad below replies. An eligible wait starts the request. The same card stays visible while the answer streams and after the reply finishes, until dismissed, opened or expired. A request already in flight may finish after a fast answer and show that same card. Having text or attachments in the composer hides it to leave more room for writing. Clearing or sending the draft lets the cached card return. A request that has already been sent is not cancelled when the view hides: Elo counts that ad as served, so the response is cached for its chat and rendered when the tab is visible again. Only a request that has not reached `fetchAds` is abandoned while hidden.

Each chat caches its ad in memory for five minutes from receipt. Later waits reuse that ad. New ads use one shared five-minute view-based cooldown across chats and tabs, with no turn-count requirement. The SDK considers an ad viewed after at least half is visible for one continuous second. Explicit dismissal or a successful link open clears cached ads and suppresses new ads for five minutes, including a quick dismissal before viewability is measured. Consent withdrawal clears the cache. Other failed consent checks may discard a card without starting a new cooldown.

Only an eligible wait can initiate a new request. A long wait can replace an expired card once the cooldown permits it. After a reply finishes, expiry removes the existing card without requesting a replacement. All request attempts share a minimum 30-second interval, including successful requests before an impression is measured. Viewed or explicitly dismissed ads use the longer five-minute cooldown. A different waiting turn resumes automatically after the shared request slot and cooldown become available; the failed turn is not retried. Stopped or failed runs, typing, a chat switch, an obscured conversation or backgrounding cancel pending requests. Restored history alone never initiates requests. Ads are not saved in the transcript.

Free users with device consent see a short opt-in during their first visible wait, with privacy details in an Acode dialog. The opt-in sits above the input and, once at least half visible, stays in that chat until answered. Deleting that chat or closing its last bound agent tab frees the unanswered offer for another eligible wait; switching tabs or temporarily hiding the chat preserves ownership. Closing a tab aborts its in-flight sponsor request and releases its pending request slot, while preserving cached ads and shared cooldowns. Allowing suggestions makes the current wait eligible immediately. Frequency state lasts for the plugin session. The pinned Elo SDK aborts ad fetches after three seconds, and native consent reads also have a three-second timeout. When upgrading the SDK, run `npm test` and verify the sponsor layout on a device: disclosure placement and failed-image fallback depend on its DOM structure.

## Android consent file fallback

Consent results are not cached after a check completes: a timed cache could reuse an earlier permission after withdrawal. Overlapping reads sharing an `AbortSignal` reuse the pending check; subsequent interactions read fresh state. The fallback still costs two native calls and two file reads when all eligibility checks pass.

When `admob.privacy.getState()` omits `iabSignals`, Android builds read `<cordova.file.applicationStorageDirectory>/shared_prefs/<BuildInfo.packageName>_preferences.xml` using `acode.require("fsOperation")`. No native changes, new CMP account, hosted page, storage permission prompt, or preference writes are needed. The parser returns only the five Elo IAB fields plus `IABTCF_PurposeConsents` and `IABTCF_PurposeLegitimateInterests`; unrelated preferences are discarded and never logged.

Each check compares two fresh file reads and rechecks native eligibility, under the existing three-second deadline. Missing or invalid files, inconsistent reads, missing GDPR applicability, incomplete required signals, missing or denied Purpose 1 consent, or no consent or legitimate interest for Purposes 2 and 7 block ads. A refusal of Purpose 1, or of Purposes 2/7 when the legitimate-interest bits are present, is a denial and clears the Elo identifier; when the legitimate-interest key is absent and Purposes 2/7 lack consent, ads pause and the identifier is kept. A native snapshot that includes `IABTCF_PurposeConsents` gets the same purpose check; one without it is trusted as validated by the host. Supplied purpose values must be bit strings (numbers are rejected because they lose leading zeros). `IABTCF_PurposeLegitimateInterests` is optional when consent grants Purposes 1, 2 and 7. Hosts must supply LI bits when relying on legitimate interest for Purpose 2 or 7; without those bits, missing Purpose 2/7 consent pauses ads and keeps the identifier. An empty LI value is treated like a missing one. Refusal clears the Elo identifier even when UMP still permits limited ads. Existing native snapshots, including an empty object, are authoritative and skip the file fallback: missing entries are cleared rather than filled from disk. An empty snapshot with `obtained` is unavailable; with `notRequired` and `canRequestAds=true`, the existing native path permits a request with all five signals absent. Hosts must omit `iabSignals` to request the Android fallback instead of returning a placeholder `{}`. The native snapshot contract requires GPP string and section IDs together when either is present; incomplete pairs are unavailable. iOS does not attempt Android file access.

This is a compatibility fallback, not an atomic SharedPreferences API: Android can update memory before flushing the file, and two matching reads cannot prove a flush has completed. The emulator checks verify decisions after the UMP callback, not every possible disk-write race. Elo confirmed the consent setup: it uses the GDPR flag and TC/GPP strings on every ad request, has no IAB vendor ID, and requires only Purposes 1, 2 and 7; Purposes 3/4 are not needed. LI for 2 and 7 is accepted, and consent for 2 and 7 gives better fill. GPP is forwarded when present, and a missing GPP field is never fabricated. A GPP-only file without explicit GDPR applicability remains unavailable. The pinned Elo web SDK forwards the strings and checks for a missing TC string; Elo’s backend applies the consent choices to each request.

Eligibility is based on the supplied signals, not an EEA-only region restriction. Both EEA consent and explicit non-EEA applicability were verified. A file containing only GPP, with no explicit GDPR applicability, stays blocked; US GPP-only support is not claimed. GPP itself also supports EU TCF, so its presence is not a substitute for `IABTCF_gdprApplies`.

### Emulator regression check

The updated runner passed all nine checks in both normal and `E2E_SCREENSHOTS` modes on 2026-11-24 with the Android 15 / Acode 1.13.6 / UMP 4.0.0 / WebView 124 environment recorded below. The normal run started before CDP forwarding existed and recovered once the socket was forwarded. Screenshot mode saved all three PNG previews using `adb`. Seven focused startup tests cover target rediscovery, readiness, immediate failure for code errors or unsafe hosts, bounded retries with the last transport error retained, and null/undefined snapshots retried after the polling delay. The snapshot guard was added after these emulator runs and verified by the focused tests.

During startup, temporary CDP connection/context failures are retried and the WebView target is rediscovered within the 60-second deadline. Evaluation errors and unsafe hosts fail immediately; a startup timeout includes the last CDP error. These retries do not apply to consent assertions or reconnect a running test after it loses its injected state.

Run this check before releases and after Acode, UMP, or WebView upgrades, and record the tested versions. The form automation depends on private UMP DOM classes and English labels, verified with UMP 4.0.0 and WebView 124; these are not stable SDK APIs. If the form changes, inspect it and update the interaction helpers while retaining the consent and network assertions. CI verifies packaging and unit behavior; it does not run this emulator check.

Use a **disposable Android emulator** with a debuggable free Acode APK and Google's Publisher Test Ads UMP configuration. Finish Acode startup first. This test resets that emulator's UMP consent, accepts/refuses test forms, and temporarily changes the plugin opt-in. The script itself does not write native preference files or alter Acode's native code; UMP persists the test choices made through its forms.

Forward Acode's WebView debugging socket (replace `<pid>` with the result of `adb -s emulator-5580 shell pidof com.foxdebug.acodefree`):

```sh
adb -s emulator-5580 forward tcp:9555 localabstract:webview_devtools_remote_<pid>
node tests/e2e/androidConsent.mjs
```

The runner waits up to 60 seconds for the editor to be visible and the free debug host's AdMob initialization (`window.ad`) to finish before resetting UMP. Finish native permission and update prompts first; otherwise the startup check times out instead of racing the host's consent collection. To save previews of the initial form, LI-only choices, and Purpose 2 refusal, set `E2E_SCREENSHOTS=/tmp/acode-consent-previews` and optionally `ANDROID_SERIAL` (defaults to `emulator-5580`). Use the same emulator as the forwarded CDP connection. Preview mode requires `adb`, logs each PNG path, and pauses six seconds at each checkpoint; omit `E2E_SCREENSHOTS` for the normal fast run.

Run from the repository root with Node 22 or newer. Set `CDP_PORT` if using a different forwarded port. The script uses the real UMP dialog, native state, file bridge, plugin consent code, and pinned Elo SDK. Elo HTTP responses are intercepted locally, so it does not produce live Elo ad requests or impressions. It verifies unknown-state blocking, accepted TC/Additional Consent forwarding, shared-storage restoration, withdrawal/identifier removal, re-consent, and the non-EEA flow. It also reports the real UMP file keys, purpose-bit length and legitimate-interest bits to expose format changes. After accepting, it requires a persisted, nonempty binary legitimate-interest value and checks Purpose 1 by consent plus Purposes 2 and 7 by consent or legitimate interest. The stricter LI-shape assertion verifies this UMP build's output; the runtime can still allow ads without the LI key when consent grants all three purposes.

Revalidated on 2026-11-24 using a disposable Android 15 emulator, WebView 124.0.6367.219, and the existing Acode 1.13.6 debug APK (version code 1013), containing UMP 4.0.0 (verified from the APK's `user-messaging-platform.properties`). The runner bundles the current plugin sources into this older host APK's WebView. EEA acceptance produced a real 712-character TC string, **11-bit** `IABTCF_PurposeConsents` (`11111111111`), and **11-bit** `IABTCF_PurposeLegitimateInterests` (`01000011111`). Unknown-state blocking, TC/Additional Consent forwarding, shared-storage restoration, withdrawal/identifier removal, and re-consent all passed. The non-EEA test persisted `IABTCF_gdprApplies=0` with no TC string and passed the consent-to-SDK flow.

The E2E also uses the real UMP "Manage options" controls: Purpose 1 consent alone (`10000000000`) plus LI for Purposes 2/7 (`01000010000`) allowed an intercepted SDK request. Refusing LI for either Purpose 2 or 7, or both, while leaving their consent off denied ads, sent no new Elo requests, and left no Elo identifier. No native preference files were edited to create these cases. Keep the strict LI-shape assertion for this verified UMP test configuration. Do not require 24 purpose bits in the preference field: the [IAB in-app specification](https://github.com/InteractiveAdvertisingBureau/GDPR-Transparency-and-Consent-Framework/blob/master/TCFv2/IAB%20Tech%20Lab%20-%20CMP%20API%20v2.md#in-app-details) defines indexed binary consent values without that fixed-length requirement. This validates the consent-to-SDK path with local Elo responses, not the full chat UI or live inventory. Live US GPP collection, real Elo ad fill, and iOS consent remain unverified. GPP forwarding and malformed/missing-file behavior have unit coverage.

The inspected Acode privacy bridge exposes only `disabled`, `eea`, and `notEea` debug geographies. It does not expose UMP’s regulated-US-state test setting, so the non-EEA test is not a US allow/opt-out test. That flow still needs a suitable device/network or a host build exposing the required test geography. No native host changes were made.
