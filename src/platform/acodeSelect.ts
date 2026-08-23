export function pickAcodeSelect(title: string, items: Acode.SelectItem[], current?: string): Promise<string | undefined> {
	if (typeof acode?.select !== "function") return Promise.resolve(undefined);
	return new Promise((resolve) => {
		let settled = false;
		const finish = (value?: string) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		void acode.select(title, items, { default: current, textTransform: false, onCancel: () => finish() }).then(finish, () => finish());
	});
}
