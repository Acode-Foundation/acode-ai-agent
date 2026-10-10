import { expect, test, vi } from "vitest";
import { useState } from "preact/hooks";
import type { AgentController } from "../src/app/agentController";
import { PortableCredentialStore } from "../src/platform/credentials";
import { useProviderCredential, watchProviderCredential } from "../src/ui/useProviderCredential";

vi.mock("preact/hooks", () => ({ useState: vi.fn(), useEffect: vi.fn() }));

test("successful sign-in bridges a delayed credential read only for its provider", () => {
  vi.mocked(useState).mockReturnValue([{ providerId: "openrouter", connected: false }, vi.fn()]);
  const controller = {
    state: { authFlow: { providerId: "openrouter", status: "connected" } },
  } as AgentController;
  expect(useProviderCredential(controller, "openrouter", [])).toBe(true);
  expect(useProviderCredential(controller, "github-copilot", [])).toBeUndefined();
  controller.state.authFlow = undefined;
  expect(useProviderCredential(controller, "openrouter", [])).toBe(false);
});

test("updates provider setup after API-key save, OAuth sign-in, and disconnect", async () => {
  const credentials = new PortableCredentialStore(null);
  const controller = {
    credentials,
    hasCredential: async (id: string) => Boolean(await credentials.read(id)),
  };
  const changed = vi.fn();
  const stop = watchProviderCredential(controller, "openrouter", changed);
  await vi.waitFor(() => expect(changed).toHaveBeenLastCalledWith(false));
  await credentials.setApiKey("openrouter", "test-key");
  await vi.waitFor(() => expect(changed).toHaveBeenLastCalledWith(true));
  await credentials.delete("openrouter");
  await vi.waitFor(() => expect(changed).toHaveBeenLastCalledWith(false));
  await credentials.modify("openrouter", async () => ({
    type: "oauth",
    access: "test-access",
    refresh: "test-refresh",
    expires: Date.now() + 60_000,
  }));
  await vi.waitFor(() => expect(changed).toHaveBeenLastCalledWith(true));
  changed.mockClear();
  await credentials.setApiKey("deepseek", "unrelated-key");
  expect(changed).not.toHaveBeenCalled();
  stop();
});

test("ignores stale credential reads and callbacks after the view closes", async () => {
  const credentials = new PortableCredentialStore(null);
  const reads: Array<(connected: boolean) => void> = [];
  const controller = {
    credentials,
    hasCredential: () => new Promise<boolean>((resolve) => reads.push(resolve)),
  };
  const changed = vi.fn();
  const stop = watchProviderCredential(controller, "openrouter", changed);
  await credentials.setApiKey("openrouter", "test-key");
  reads[1](true);
  await vi.waitFor(() => expect(changed).toHaveBeenLastCalledWith(true));
  reads[0](false);
  await Promise.resolve();
  expect(changed).toHaveBeenCalledTimes(1);
  await credentials.delete("openrouter");
  stop();
  reads[2](false);
  await Promise.resolve();
  expect(changed).toHaveBeenCalledTimes(1);
});
