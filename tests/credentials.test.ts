import {
  createModels,
  createProvider,
  type Credential,
  type CredentialStore,
  type OAuthCredential,
} from "@earendil-works/pi-ai";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import { PortableCredentialStore } from "../src/platform/credentials.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test.each([
  { name: "saves a queued login after the earlier mutation finishes", cancel: false },
  { name: "does not save a queued login after it is cancelled", cancel: true },
])("$name", async ({ cancel }) => {
  const providerId = "synthetic-provider";
  const retained: OAuthCredential = {
    type: "oauth",
    access: "synthetic-access-a",
    refresh: "synthetic-refresh-a",
    expires: Number.MAX_SAFE_INTEGER,
  };
  const incoming: OAuthCredential = {
    type: "oauth",
    access: "synthetic-access-b",
    refresh: "synthetic-refresh-b",
    expires: Number.MAX_SAFE_INTEGER,
  };
  const credentials: CredentialStore = new PortableCredentialStore(null);
  const modify = credentials.modify.bind(credentials);
  const activeStarted = deferred<void>();
  const releaseActive = deferred<void>();
  const loginQueued = deferred<AbortSignal | undefined>();
  const abort = new AbortController();
  const network = vi.fn(() => {
    throw new Error("This test must not make network requests.");
  });
  vi.stubGlobal("fetch", network);

  const loginProvider = vi.fn(async () => incoming);
  const models = createModels({
    credentials,
    authContext: {
      async env() {
        return undefined;
      },
      async fileExists() {
        return false;
      },
    },
  });
  models.setProvider(
    createProvider({
      id: providerId,
      name: "Synthetic provider",
      models: [],
      auth: {
        oauth: {
          name: "Synthetic OAuth",
          login: loginProvider,
          async refresh(credential) {
            return credential;
          },
          async toAuth(credential) {
            return { apiKey: credential.access };
          },
        },
      },
      api: {
        stream() {
          throw new Error("This test must not start inference.");
        },
        streamSimple() {
          throw new Error("This test must not start inference.");
        },
      },
    }),
  );

  const active = modify(providerId, async () => {
    activeStarted.resolve();
    await releaseActive.promise;
    return retained;
  });

  onTestFinished(async () => {
    releaseActive.resolve();
    await active;
    await modify(providerId, async () => undefined);
  });

  await activeStarted.promise;
  const modifySpy = vi.spyOn(credentials, "modify").mockImplementation((id, update, options) => {
    const pending = modify(id, update, options);
    loginQueued.resolve(options?.signal);
    return pending;
  });
  const outcome = models
    .login(providerId, "oauth", {
      signal: abort.signal,
      async prompt() {
        throw new Error("The synthetic login must not prompt.");
      },
      notify() {},
    })
    .then(
      (credential) => ({ status: "fulfilled", credential }),
      (reason: unknown) => ({ status: "rejected", reason }),
    );

  const queuedSignal = await Promise.race([
    loginQueued.promise,
    outcome.then((result) => {
      throw new Error("Login settled before its credential mutation was queued.", {
        cause: result,
      });
    }),
  ]);
  expect(loginProvider).toHaveBeenCalledOnce();
  expect(modifySpy).toHaveBeenCalledOnce();
  expect(queuedSignal?.aborted).toBe(false);
  expect(await credentials.read(providerId)).toBeUndefined();

  if (cancel) {
    abort.abort();
    expect(queuedSignal?.aborted).toBe(true);
    expect(await outcome).toMatchObject({
      status: "rejected",
      reason: { name: "AbortError" },
    });
  }

  releaseActive.resolve();
  await active;
  await modify(providerId, async () => undefined);

  if (!cancel) {
    expect(await outcome).toEqual({ status: "fulfilled", credential: incoming });
  }
  expect(network).not.toHaveBeenCalled();
  expect(await credentials.read(providerId)).toEqual(cancel ? retained : incoming);
});

test.each(["modify", "delete"] as const)("does not start a pre-aborted %s", async (operation) => {
  const { store, values, getSecret, setSecret } = secretStore();
  const retained = syntheticCredential("retained");
  values.set("provider:synthetic-provider", JSON.stringify(retained));
  const update = vi.fn(async () => syntheticCredential("cancelled"));
  const abort = new AbortController();
  const reason = new Error("Synthetic cancellation");
  abort.abort(reason);

  const pending =
    operation === "modify"
      ? store.modify("synthetic-provider", update, { signal: abort.signal })
      : store.delete("synthetic-provider", { signal: abort.signal });

  await expect(pending).rejects.toBe(reason);
  expect(update).not.toHaveBeenCalled();
  expect(getSecret).not.toHaveBeenCalled();
  expect(setSecret).not.toHaveBeenCalled();
  expect(values.get("provider:synthetic-provider")).toBe(JSON.stringify(retained));
});

test("a cancelled queued delete leaves the preceding credential intact", async () => {
  const { store } = secretStore();
  const retained = syntheticCredential("retained");
  const entered = deferred<void>();
  const release = deferred<void>();
  const abort = new AbortController();
  const active = store.modify("synthetic-provider", async () => {
    entered.resolve();
    await release.promise;
    return retained;
  });
  onTestFinished(async () => {
    release.resolve();
    await active;
    await store.modify("synthetic-provider", async () => undefined);
  });
  await entered.promise;

  const cancelled = store.delete("synthetic-provider", { signal: abort.signal });
  const result = expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
  abort.abort();
  release.resolve();
  await active;
  await result;

  expect(await store.read("synthetic-provider")).toEqual(retained);
});

test("cancellation during the initial secret read prevents the mutation callback", async () => {
  const { store, values, getSecret, setSecret } = secretStore();
  const retained = syntheticCredential("retained");
  values.set("provider:synthetic-provider", JSON.stringify(retained));
  const entered = deferred<void>();
  const release = deferred<void>();
  getSecret.mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    return JSON.stringify(retained);
  });
  onTestFinished(() => release.resolve());
  const update = vi.fn(async () => syntheticCredential("cancelled"));
  const abort = new AbortController();
  const pending = store.modify("synthetic-provider", update, { signal: abort.signal });
  const result = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await entered.promise;
  abort.abort();
  release.resolve();
  await result;

  expect(update).not.toHaveBeenCalled();
  expect(setSecret).not.toHaveBeenCalled();
  expect(await store.read("synthetic-provider")).toEqual(retained);
});

test("cancellation after the mutation starts preserves its rotated credential and queue ownership", async () => {
  const { store, values } = secretStore();
  const retained = syntheticCredential("retained");
  const rotated = syntheticCredential("rotated");
  values.set("provider:synthetic-provider", JSON.stringify(retained));
  const entered = deferred<void>();
  const release = deferred<void>();
  const abort = new AbortController();
  const events: string[] = [];
  const active = store.modify(
    "synthetic-provider",
    async (current) => {
      expect(current).toEqual(retained);
      entered.resolve();
      await release.promise;
      events.push("mutation finished");
      return rotated;
    },
    { signal: abort.signal },
  );
  onTestFinished(async () => {
    release.resolve();
    await active;
    await store.modify("synthetic-provider", async () => undefined);
  });
  await entered.promise;
  abort.abort();
  const observe = vi.fn(async () => {
    events.push("following mutation");
    return undefined;
  });
  const following = store.modify("synthetic-provider", observe);
  await store.modify("other-provider", async () => undefined);
  expect(observe).not.toHaveBeenCalled();
  release.resolve();

  await expect(active).resolves.toEqual(rotated);
  await following;
  expect(observe).toHaveBeenCalledWith(rotated);
  expect(events).toEqual(["mutation finished", "following mutation"]);
  expect(await store.read("synthetic-provider")).toEqual(rotated);
});

test.each([false, true])(
  "an active storage write retains the queue after cancellation (write fails: %s)",
  async (fails) => {
    const { store, values, setSecret } = secretStore();
    const retained = syntheticCredential("retained");
    const incoming = syntheticCredential("incoming");
    values.set("provider:synthetic-provider", JSON.stringify(retained));
    const entered = deferred<void>();
    const release = deferred<void>();
    const storageError = new Error("Synthetic storage failure");
    const events: string[] = [];
    setSecret.mockImplementationOnce(async (key, value) => {
      events.push("write started");
      entered.resolve();
      await release.promise;
      events.push("write settled");
      if (fails) throw storageError;
      values.set(key, value);
    });
    const abort = new AbortController();
    const active = store.modify("synthetic-provider", async () => incoming, {
      signal: abort.signal,
    });
    const outcome = active.then(
      (credential) => ({ status: "fulfilled", credential }),
      (reason: unknown) => ({ status: "rejected", reason }),
    );
    onTestFinished(async () => {
      release.resolve();
      await outcome;
      await store.modify("synthetic-provider", async () => undefined);
    });
    await entered.promise;
    abort.abort();
    const observe = vi.fn(async () => {
      events.push("following mutation");
      return undefined;
    });
    const following = store.modify("synthetic-provider", observe);
    await store.modify("other-provider", async () => undefined);
    expect(observe).not.toHaveBeenCalled();
    release.resolve();

    expect(await outcome).toEqual(
      fails
        ? { status: "rejected", reason: storageError }
        : { status: "fulfilled", credential: incoming },
    );
    await following;
    expect(observe).toHaveBeenCalledWith(fails ? retained : incoming);
    expect(events).toEqual(["write started", "write settled", "following mutation"]);
    expect(await store.read("synthetic-provider")).toEqual(fails ? retained : incoming);
  },
);

test("a failed mutation does not poison the following operation", async () => {
  const { store, values } = secretStore();
  const retained = syntheticCredential("retained");
  values.set("provider:synthetic-provider", JSON.stringify(retained));
  const failure = new Error("Synthetic mutation failure");
  const failed = store.modify("synthetic-provider", async () => {
    throw failure;
  });
  const result = expect(failed).rejects.toBe(failure);
  const observe = vi.fn(async () => undefined);
  const following = store.modify("synthetic-provider", observe);

  await result;
  await following;
  expect(observe).toHaveBeenCalledWith(retained);
});

function secretStore() {
  const values = new Map<string, string>();
  const getSecret = vi.fn(async (key: string, fallback = "") => values.get(key) ?? fallback);
  const setSecret = vi.fn(async (key: string, value: string) => {
    values.set(key, value);
  });
  const context = { getSecret, setSecret } as unknown as Acode.PluginContext;
  const store: CredentialStore = new PortableCredentialStore(context);
  return { store, values, getSecret, setSecret };
}

function syntheticCredential(suffix: string): Credential {
  return {
    type: "oauth",
    access: `synthetic-access-${suffix}`,
    refresh: `synthetic-refresh-${suffix}`,
    expires: Number.MAX_SAFE_INTEGER,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
