import { useEffect, useState } from "preact/hooks";
import type { AgentController } from "../app/agentController";
import type { CustomEndpoint } from "../providers/customEndpoints";

type CredentialSource = Pick<AgentController, "hasCredential" | "credentials">;

/** Ignore old reads after a credential changes, the provider changes, or the view closes. */
export function watchProviderCredential(
  controller: CredentialSource,
  providerId: string,
  onChange: (connected: boolean) => void,
): () => void {
  let revision = 0;
  const refresh = () => {
    const current = ++revision;
    void controller.hasCredential(providerId).then(
      (connected) => {
        if (current === revision) onChange(connected);
      },
      () => {
        if (current === revision) onChange(false);
      },
    );
  };
  const unsubscribe = controller.credentials.changes.subscribe((changed) => {
    if (changed === providerId) refresh();
  });
  refresh();
  return () => {
    revision++;
    unsubscribe();
  };
}

export function useProviderCredential(
  controller: AgentController,
  providerId: string,
  endpoints: readonly CustomEndpoint[],
): boolean | undefined {
  const [result, setResult] = useState<{ providerId: string; connected: boolean }>();
  useEffect(
    () =>
      watchProviderCredential(controller, providerId, (connected) => {
        setResult({ providerId, connected });
      }),
    [controller, providerId, endpoints],
  );
  // Login completes after persistence; the async secret read can still contain the old result.
  const authFlow = controller.state.authFlow;
  if (authFlow?.providerId === providerId && authFlow.status === "connected") return true;
  return result?.providerId === providerId ? result.connected : undefined;
}
