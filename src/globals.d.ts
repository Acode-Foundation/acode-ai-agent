declare module "*.css" {
	const content: string;
	export default content;
}

interface SDcardDocumentFile {
	uri: string;
	url?: string;
	filename?: string;
	name?: string;
	type?: string;
	length?: number;
}

interface SDcard {
	openDocumentFile(
		onSuccess: (file: SDcardDocumentFile | string) => void,
		onFail: (error: unknown) => void,
		mimeType?: string,
	): void;
	getImage?(
		onSuccess: (uri: string | SDcardDocumentFile) => void,
		onFail: (error: unknown) => void,
		mimeType?: string,
	): void;
}

interface SystemPlugin {
	getFilesDir(success: (dir: string) => void, error?: (err: unknown) => void): void;
}

interface BuildInfoPlugin {
	packageName?: string;
}

declare var sdcard: SDcard | undefined;
declare var system: SystemPlugin | undefined;
declare var BuildInfo: BuildInfoPlugin | undefined;
