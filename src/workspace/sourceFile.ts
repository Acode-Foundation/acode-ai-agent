let lastSourceFile: Acode.EditorFile | null = null;

export function isSourceEditorFile(file: Acode.EditorFile | null | undefined): file is Acode.EditorFile {
	if (!file || (file.type && file.type !== "editor")) return false;
	return typeof file.uri === "string" && file.uri.length > 0;
}

export function resolveSourceFile(preferred?: Acode.EditorFile | null): Acode.EditorFile | undefined {
	const files = window.editorManager?.files ?? [];
	if (lastSourceFile && !files.some((file) => file.id === lastSourceFile?.id)) lastSourceFile = null;
	return [preferred, lastSourceFile, window.editorManager?.activeFile, ...files].find(isSourceEditorFile);
}

export function rememberSourceFile(file?: Acode.EditorFile | null): void {
	if (isSourceEditorFile(file)) lastSourceFile = file;
}

export function subscribeToSourceFiles(): () => void {
	const manager = window.editorManager;
	if (!manager?.on) return () => undefined;
	rememberSourceFile(manager.activeFile);
	const onSwitch = (file: Acode.EditorFile) => rememberSourceFile(file);
	const onRemove = (file: Acode.EditorFile) => {
		if (lastSourceFile?.id === file?.id) lastSourceFile = null;
	};
	manager.on("switch-file", onSwitch);
	manager.on("remove-file", onRemove);
	return () => {
		manager.off("switch-file", onSwitch);
		manager.off("remove-file", onRemove);
	};
}

export function selectedText(file: Acode.EditorFile): string {
	try {
		const editor = window.editorManager?.editor;
		if (window.editorManager?.activeFile?.id === file.id) {
			return editor?.getCopyText?.().trim() ?? "";
		}
		const session = file.session as { getSelection?: () => { getRange?: () => unknown }; getTextRange?: (range: unknown) => string } | undefined;
		const range = session?.getSelection?.()?.getRange?.();
		if (session?.getTextRange && range) return String(session.getTextRange(range) ?? "").trim();
	} catch {
		// Selection is optional context.
	}
	return "";
}
