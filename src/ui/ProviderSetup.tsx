import type { ProviderDescriptor } from "../providers/providerRegistry";
import { AgentIcon } from "./AgentIcon";

export function ProviderSetup({
  provider,
  connected,
  onConfigure,
}: {
  provider?: ProviderDescriptor;
  connected?: boolean;
  onConfigure(): void;
}) {
  if (!provider || connected !== false) return null;
  return (
    <div class="provider-setup">
      <AgentIcon size={22} />
      <div>
        <b>Connect to {provider.name}</b>
        <span>{provider.subscriptionLabel ? "Sign in" : "Add an API key"} to start chatting.</span>
      </div>
      <button type="button" onClick={onConfigure}>
        Configure
      </button>
    </div>
  );
}
