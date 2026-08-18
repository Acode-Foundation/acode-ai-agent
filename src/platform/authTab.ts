type CustomTabApi = {
	open(url: string, options?: { showTitle?: boolean; toolbarColor?: string }, success?: () => void, error?: (message: string) => void): void;
};

/** Opens the provider sign-in page in Acode's Custom Tab (default browser session). */
export async function openAuthTab(url: string): Promise<void> {
	const href = secureHttpUrl(url);
	const tabs = getCustomTabs();
	await new Promise<void>((resolve, reject) => {
		tabs.open(
			href,
			{ showTitle: true },
			() => resolve(),
			(message) => reject(new Error(message || "Could not open the sign-in tab.")),
		);
	});
}

function getCustomTabs(): CustomTabApi {
	const tabs = (globalThis as { CustomTabs?: CustomTabApi }).CustomTabs;
	if (tabs && typeof tabs.open === "function") return tabs;

	const exec = (globalThis as { cordova?: { exec?: (success: () => void, error: (message: string) => void, service: string, action: string, args: unknown[]) => void } }).cordova?.exec;
	if (!exec) throw new Error("Acode custom tabs are required for sign-in.");
	return {
		open(url, options, success, error) {
			exec(success ?? (() => undefined), error ?? (() => undefined), "CustomTabs", "open", [url, options ?? {}]);
		},
	};
}

function secureHttpUrl(value: string): string {
	const url = new URL(value);
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new Error("Sign-in URL must be http(s).");
	}
	return url.href;
}
