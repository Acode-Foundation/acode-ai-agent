// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { bindPromptKeyboard } from "../src/ui/composerKeyboard";

let input: HTMLElement;
let cleanup: () => void;
let settings: { keyboardMode: string };
let callbacks: Array<() => void>;
let switched: () => void;
const setInputType = vi.fn();
beforeEach(() => {
  settings = { keyboardMode: "NO_SUGGESTIONS_AGGRESSIVE" };
  callbacks = [];
  setInputType.mockReset().mockImplementation((_mode, ready) => callbacks.push(ready));
  vi.stubGlobal("system", { setInputType });
  vi.stubGlobal("acode", { require: () => ({ value: settings }) });
  vi.stubGlobal("cordova", { platformId: "android" });
  vi.stubGlobal("editorManager", {
    on: (_event: string, cb: () => void) => {
      switched = cb;
    },
    off: vi.fn(),
  });
  const host = document.createElement("div");
  document.body.append(host);
  input = document.createElement("div");
  input.contentEditable = "true";
  input.tabIndex = 0;
  input.textContent = "Explain this code";
  host.attachShadow({ mode: "open" }).append(input);
  cleanup = bindPromptKeyboard(input);
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
const modes = () => setInputType.mock.calls.map(([mode]) => mode);

test("normal IME is scoped to prompt focus and cleanup restores the preference", () => {
  expect(modes()).toEqual([]);
  input.focus();
  expect(modes()).toEqual(["NORMAL"]);
  callbacks[0]?.();
  expect(modes()).toEqual(["NORMAL"]); // reconnect must not restore the editor mode
  expect((input.getRootNode() as ShadowRoot).activeElement).toBe(input);
  cleanup();
  expect(modes()).toEqual(["NORMAL", "NO_SUGGESTIONS_AGGRESSIVE"]);
  input.blur();
  input.focus();
  expect(modes()).toHaveLength(2);
});

test("a late native acknowledgement cannot steal focus back after blur", () => {
  input.focus();
  const other = document.createElement("input");
  document.body.append(other);
  other.focus();
  callbacks[0]?.();
  expect(document.activeElement).toBe(other);
  expect(modes()).toEqual(["NORMAL", "NO_SUGGESTIONS_AGGRESSIVE"]);
});

test("Android reconnect preserves the selection and draft", () => {
  input.focus();
  const selection = document.getSelection();
  const range = document.createRange();
  range.setStart(input.firstChild as Text, 2);
  range.setEnd(input.firstChild as Text, 7);
  selection?.addRange(range);
  callbacks[0]?.();
  expect(selection?.toString()).toBe("plain");
  expect(input.textContent).toBe("Explain this code");
});

test("restores the latest preference when the prompt loses focus", () => {
  input.focus();
  settings.keyboardMode = "NO_SUGGESTIONS";
  input.blur();
  expect(modes()).toEqual(["NORMAL", "NO_SUGGESTIONS"]);
});

test("switching away from a hidden tab restores IME even without DOM blur", () => {
  input.focus();
  vi.spyOn(input, "getClientRects").mockReturnValue([] as unknown as DOMRectList);
  switched();
  callbacks[0]?.();
  expect(modes()).toEqual(["NORMAL", "NO_SUGGESTIONS_AGGRESSIVE"]);
});

test("cleanup cancels a pending reconnect", () => {
  input.focus();
  const focus = vi.spyOn(input, "focus");
  cleanup();
  callbacks[0]?.();
  expect(focus).not.toHaveBeenCalled();
});

test("iOS uses the bridge without refocusing the editable", () => {
  vi.stubGlobal("cordova", { platformId: "ios" });
  input.focus();
  const focus = vi.spyOn(input, "focus");
  callbacks[0]?.();
  expect(focus).not.toHaveBeenCalled();
  input.blur();
  expect(modes()).toEqual(["NORMAL", "NO_SUGGESTIONS_AGGRESSIVE"]);
});

test("missing or throwing native bridges leave ordinary input usable", () => {
  vi.stubGlobal("system", undefined);
  input.focus();
  expect(modes()).toEqual([]);
  input.blur();
  vi.stubGlobal("system", {
    setInputType: () => {
      throw Error("unavailable");
    },
  });
  expect(() => input.focus()).not.toThrow();
  expect(() => cleanup()).not.toThrow();
});

test("a delayed acknowledgement waits for IME composition to finish", () => {
  input.focus();
  input.dispatchEvent(new CompositionEvent("compositionstart"));
  const blur = vi.spyOn(input, "blur");
  callbacks[0]?.();
  expect(blur).not.toHaveBeenCalled();
  input.dispatchEvent(new CompositionEvent("compositionend"));
  expect(blur).toHaveBeenCalledOnce();
  expect(modes()).toEqual(["NORMAL"]);
});

test("leaving the prompt cancels a reconnect deferred by composition", () => {
  input.focus();
  input.dispatchEvent(new CompositionEvent("compositionstart"));
  callbacks[0]?.();
  input.blur();
  const focus = vi.spyOn(input, "focus");
  input.dispatchEvent(new CompositionEvent("compositionend"));
  expect(focus).not.toHaveBeenCalled();
  expect(modes()).toEqual(["NORMAL", "NO_SUGGESTIONS_AGGRESSIVE"]);
});

test("cleanup restores the captured preference when settings become unavailable", () => {
  input.focus();
  vi.stubGlobal("acode", {
    require: () => {
      throw Error("host shutting down");
    },
  });
  cleanup();
  expect(modes()).toEqual(["NORMAL", "NO_SUGGESTIONS_AGGRESSIVE"]);
});
