// @vitest-environment happy-dom
import "fake-indexeddb/auto";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AgentController } from "../src/app/agentController";
import { finalizeCustomEndpoint } from "../src/providers/customEndpoints";
import { App } from "../src/ui/App";
import { showToast } from "../src/platform/toast";

vi.mock("../src/platform/toast", () => ({ showToast: vi.fn() }));

vi.mock("../src/ui/motion", () => ({
  enterSheet: vi.fn(),
  exitSheet: vi.fn(async () => {}),
  stopMotion: vi.fn(),
  fadeSlide: vi.fn(async () => {}),
}));

const endpoint = finalizeCustomEndpoint(
  { name: "Worker", baseUrl: "https://worker.example.com/v1", models: "custom-model" },
  [],
);
let controller: AgentController;
let root: HTMLDivElement;
let requests: Request[];

beforeEach(() => {
  localStorage.clear();
  requests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({ data: [{ id: "custom-model" }] });
    }),
  );
  controller = new AgentController(null);
  controller.settings.update({
    customEndpoints: [endpoint],
    providerId: endpoint.id,
    modelId: "custom-model",
  });
  root = document.createElement("div");
  document.body.append(root);
});

afterEach(async () => {
  await act(() => render(null, root));
  root.remove();
  await controller.dispose();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function openAccess() {
  await act(() => render(h(App, { controller, isTabActive: () => true }), root));
  await act(() => root.querySelector<HTMLButtonElement>('[aria-label="Provider access"]')!.click());
  await vi.waitFor(() => expect(root.textContent).not.toContain("Checking credentials…"));
}

function button(label: string): HTMLButtonElement {
  const element = [...root.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === label,
  );
  expect(element, `button ${label}`).toBeDefined();
  return element!;
}

test("keyless endpoint stays usable while key entry, replacement and removal remain accessible", async () => {
  expect(await controller.hasCredential(endpoint.id)).toBe(false);
  expect(await controller.providers.models.checkAuth(endpoint.id)).toBeTruthy();
  await openAccess();
  expect(root.querySelector(".provider-setup")).toBeNull();
  expect(root.textContent).toContain("No API key configured");
  expect(root.textContent).not.toContain("Worker is connected");
  expect(root.textContent).not.toContain("Disconnect");
  expect(root.textContent).not.toContain("Remove API key");

  const key = root.querySelector<HTMLInputElement>('[aria-label="Worker API key"]')!;
  await act(() => {
    key.value = "fixture-key";
    key.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(() => button("Save").click());
  await vi.waitFor(() => expect(root.textContent).toContain("API key saved"));
  expect(await controller.hasCredential(endpoint.id)).toBe(true);
  expect(root.querySelector('[aria-label="Worker API key"]')).not.toBeNull();

  await act(() => button("Remove API key").click());
  await vi.waitFor(() => expect(root.textContent).toContain("No API key configured"));
  expect(await controller.credentials.read(endpoint.id)).toBeUndefined();
  expect(await controller.providers.models.checkAuth(endpoint.id)).toBeTruthy();
  expect(root.textContent).not.toContain("Remove API key");
  expect(root.querySelector(".provider-setup")).toBeNull();
  expect(showToast).toHaveBeenLastCalledWith("API key removed");
});

test("built-in providers still show the credential setup banner", async () => {
  controller.settings.update({ providerId: "openrouter" });
  await openAccess();
  await vi.waitFor(() => expect(root.querySelector(".provider-setup")).not.toBeNull());
  expect(root.textContent).toContain("Connect to OpenRouter");
});

test("OAuth credentials count as saved without resolving or refreshing the grant", async () => {
  expect(await controller.hasCredential("github-copilot")).toBe(false);
  await controller.credentials.modify("github-copilot", async () => ({
    type: "oauth",
    access: "fixture-access",
    refresh: "fixture-refresh",
    expires: 0,
  }));
  expect(await controller.hasCredential("github-copilot")).toBe(true);
  expect(requests).toHaveLength(0);
  await controller.credentials.delete("github-copilot");
  expect(await controller.hasCredential("github-copilot")).toBe(false);
});

test("provider-scoped environment credentials count as saved, but empty records do not", async () => {
  await controller.credentials.modify("env-provider", async () => ({ type: "api_key", env: {} }));
  expect(await controller.hasCredential("env-provider")).toBe(false);
  await controller.credentials.modify("env-provider", async () => ({
    type: "api_key",
    env: { AWS_PROFILE: "fixture-profile" },
  }));
  expect(await controller.hasCredential("env-provider")).toBe(true);
});

test("editing an endpoint reuses its stored key for both Load from /models and Save", async () => {
  await controller.credentials.setApiKey(endpoint.id, "fixture-key");
  await openAccess();
  await act(() => button("Edit endpoint").click());
  await act(() => button("Load from /models").click());
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  await vi.waitFor(() => expect(button("Save endpoint").disabled).toBe(false));
  await act(() => button("Save endpoint").click());
  await vi.waitFor(() => expect(requests).toHaveLength(2));
  await vi.waitFor(() => expect(root.querySelector(".endpoint-form")).toBeNull());
  expect(requests.map((request) => request.headers.get("Authorization"))).toEqual([
    "Bearer fixture-key",
    "Bearer fixture-key",
  ]);
  expect(await controller.credentials.read(endpoint.id)).toMatchObject({ key: "fixture-key" });
});

test.each(["https://other.example.com/v1", "https://worker.example.com/other/v1"])(
  "editing the URL never probes or saves %s with the old endpoint's key",
  async (baseUrl) => {
    await controller.credentials.setApiKey(endpoint.id, "fixture-key");
    await controller.probeCustomEndpointModels(baseUrl, "", endpoint.id);
    const saved = await controller.saveCustomEndpoint({ ...endpoint, baseUrl }, "");
    expect(saved.removedApiKey).toBe(true);
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.url).toBe(`${baseUrl}/models`);
      expect(request.headers.get("Authorization")).toBeNull();
    }
    expect(await controller.credentials.read(endpoint.id)).toBeUndefined();
    expect(await controller.hasCredential(endpoint.id)).toBe(false);
  },
);

test("a URL change with a replacement key clears the old key before exposing the new endpoint", async () => {
  const baseUrl = "https://other.example.com/v1";
  await controller.credentials.setApiKey(endpoint.id, "old-fixture-key");
  let keyAtUrlChange: ReturnType<typeof controller.credentials.read> | undefined;
  const unsubscribe = controller.settings.subscribe((settings) => {
    if (settings.customEndpoints.find((item) => item.id === endpoint.id)?.baseUrl === baseUrl)
      keyAtUrlChange ??= controller.credentials.read(endpoint.id);
  });
  try {
    const saved = await controller.saveCustomEndpoint({ ...endpoint, baseUrl }, "replacement-key");
    expect(saved.endpoint.baseUrl).toBe(baseUrl);
    expect(saved.removedApiKey).toBe(false);
    expect(keyAtUrlChange).toBeDefined();
    expect(await keyAtUrlChange).toBeUndefined();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(`${baseUrl}/models`);
    expect(requests[0]!.headers.get("Authorization")).toBe("Bearer replacement-key");
    expect(await controller.credentials.read(endpoint.id)).toMatchObject({
      key: "replacement-key",
    });
  } finally {
    unsubscribe();
  }
});

test("saving a changed URL reports that its previous key was removed", async () => {
  await controller.credentials.setApiKey(endpoint.id, "fixture-key");
  await openAccess();
  await act(() => button("Edit endpoint").click());
  const url = root.querySelector<HTMLInputElement>(
    'input[placeholder="http://192.168.1.10:8080/v1"]',
  )!;
  await act(() => {
    url.value = "https://other.example.com/v1";
    url.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(() => button("Save endpoint").click());
  await vi.waitFor(() => expect(root.querySelector(".endpoint-form")).toBeNull());
  expect(showToast).toHaveBeenLastCalledWith(
    "Worker saved. Previous API key removed because the base URL changed.",
  );
  expect(await controller.credentials.read(endpoint.id)).toBeUndefined();
});

test.each([
  {
    action: "removal",
    update: () => controller.removeCredential(endpoint.id),
    expected: undefined,
  },
  {
    action: "replacement",
    update: () => controller.saveApiKey(endpoint.id, "replacement-key"),
    expected: { type: "api_key", key: "replacement-key" },
  },
])("a pending endpoint save preserves a later credential $action", async ({ update, expected }) => {
  await controller.credentials.setApiKey(endpoint.id, "old-fixture-key");
  let finish!: (response: Response) => void;
  vi.mocked(fetch).mockImplementationOnce((input, init) => {
    requests.push(new Request(input, init));
    return new Promise<Response>((resolve) => {
      finish = resolve;
    });
  });
  const saving = controller.saveCustomEndpoint(endpoint, "");
  try {
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    await update();
    finish(Response.json({ data: [{ id: "custom-model" }] }));
    await saving;
    expect(await controller.credentials.read(endpoint.id)).toEqual(expected);
  } finally {
    finish?.(Response.json({ data: [{ id: "custom-model" }] }));
    await saving.catch(() => {});
  }
});

test("an explicitly supplied key named none is used by probes and stored unchanged", async () => {
  await controller.credentials.setApiKey(endpoint.id, "old-key");
  await controller.probeCustomEndpointModels(endpoint.baseUrl, "none", endpoint.id);
  await controller.saveCustomEndpoint(endpoint, "none");
  expect(requests.map((request) => request.headers.get("Authorization"))).toEqual([
    "Bearer none",
    "Bearer none",
  ]);
  expect(await controller.credentials.read(endpoint.id)).toMatchObject({ key: "none" });
});
