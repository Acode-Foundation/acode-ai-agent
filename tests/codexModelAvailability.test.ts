import { afterEach, expect, test, vi } from "vitest";
import { PortableCredentialStore } from "../src/platform/credentials.ts";
import { ProviderRegistry } from "../src/providers/providerRegistry.ts";
import { refreshPortableCodexModels } from "../src/providers/portableOAuth.ts";

const credential = {
  type: "oauth" as const,
  access: "access",
  refresh: "refresh",
  expires: Date.now() + 3_600_000,
  accountId: "account",
};
afterEach(() => vi.unstubAllGlobals());

async function registryWith(ids: string[]) {
  const credentials = new PortableCredentialStore(null);
  await credentials.modify("openai-codex", async () => ({
    ...credential,
    availableModelIds: ids,
    availableModelsFetchedAt: Date.now(),
  }));
  return { registry: new ProviderRegistry(credentials), credentials };
}

test("discovered Codex models remain selectable when absent from Pi's frozen catalog", async () => {
  const { registry } = await registryWith(["future-codex-model"]);
  const models = await registry.refreshModelAvailability("openai-codex");
  expect(models.map((model) => model.id)).toEqual(["future-codex-model"]);
  expect(registry.resolveModel("openai-codex", "future-codex-model")).toMatchObject({
    id: "future-codex-model",
    api: "openai-codex-responses",
    provider: "openai-codex",
    baseUrl: "https://chatgpt.com/backend-api",
  });
});

test("legacy empty availability cache recovers without another sign-in", async () => {
  const { registry, credentials } = await registryWith([]);
  const request = vi.fn(async () =>
    Response.json({ models: [{ slug: "new-codex-model", visibility: "list" }] }),
  );
  vi.stubGlobal("fetch", request);
  expect(
    (await registry.refreshModelAvailability("openai-codex")).map((model) => model.id),
  ).toEqual(["new-codex-model"]);
  expect((await credentials.read("openai-codex"))?.availableModelIds).toEqual(["new-codex-model"]);
  expect(request).toHaveBeenCalledOnce();
});

test.each(["empty", "unavailable", "malformed"])(
  "%s model discovery does not hide the built-in Codex picker",
  async (response) => {
    const { registry } = await registryWith([]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        if (response === "unavailable") throw new TypeError("Network unavailable");
        return Response.json(response === "empty" ? { models: [] } : { models: "unexpected" });
      }),
    );
    expect((await registry.refreshModelAvailability("openai-codex")).length).toBeGreaterThan(0);
    expect(registry.resolveModel("openai-codex", "gpt-5.6-terra").id).toBe("gpt-5.6-terra");
  },
);

test("forced refresh updates populated account catalogs and retains them on failure", async () => {
  const { registry } = await registryWith(["old-model"]);
  const request = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ models: [{ slug: "new-model", visibility: "list" }] }))
    .mockRejectedValueOnce(new TypeError("Offline"));
  vi.stubGlobal("fetch", request);
  expect(
    (await registry.refreshModelAvailability("openai-codex")).map((model) => model.id),
  ).toEqual(["old-model"]);
  expect(request).not.toHaveBeenCalled();
  expect(
    (await registry.refreshModelAvailability("openai-codex", true)).map((model) => model.id),
  ).toEqual(["new-model"]);
  expect(
    (await registry.refreshModelAvailability("openai-codex", true)).map((model) => model.id),
  ).toEqual(["new-model"]);
});

test("discovery excludes hidden and invalid model IDs and removes duplicates", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        models: [
          { slug: "valid-model", visibility: "list" },
          { slug: "valid-model", visibility: "list" },
          { slug: "hidden-model", visibility: "hide" },
          { slug: "https://example.com", visibility: "list" },
        ],
      }),
    ),
  );
  expect((await refreshPortableCodexModels(credential)).availableModelIds).toEqual(["valid-model"]);
});
