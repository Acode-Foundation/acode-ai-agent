import { AtSign, ListPlus, Paperclip, Send, Settings, Square } from "lucide-preact";
import { forwardRef } from "preact/compat";
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { AgentController } from "../app/agentController";
import { PERMISSION_MODES, type PermissionMode } from "../core/schema";
import type { QueuedPrompt } from "../core/types";
import { openAcodeUri, pickDeviceImage, previewImageInAcode } from "../platform/deviceImage";
import { pickAcodeFile } from "../platform/deviceFile";
import { pickAcodeSelect } from "../platform/acodeSelect";
import { imageContentFromFile } from "../platform/promptImages";
import { fileDir, fileName, type MentionFile } from "../workspace/fileMentions";
import { createFileGlyph, fileIconClass } from "./fileGlyph";
import { clearBlankEditor, consumeMention, getEditorSelection, isBlankEditor, mentionInEditor, setCaret } from "./composerDom";
import { filePlaceholder, imagePlaceholder, imageSrc, splitUserText, type ComposerDraft, type DraftFile, type DraftImage, type UserPart } from "./composerDraft";
import { filterSlashCommands, slashCommandQuery, type SlashCommand } from "../core/slashCommands";

export type ComposerHandle = {
	setText: (text: string) => void;
	restore: (draft: ComposerDraft) => void;
	focus: () => void;
};

type Props = {
	controller: AgentController;
	running: boolean;
	disabled: boolean;
	permissionMode: PermissionMode;
	effort: string;
	effortLevels: Array<{ id: string; label: string }>;
	modelName: string;
	acceptsImages: boolean | undefined;
	commands: SlashCommand[];
	autocompleteMaxVisible: number;
	onOpenConfig: () => void;
	usage: { tokens: number; cost: number };
	contextTokens: number;
	contextWindow?: number;
	queued: QueuedPrompt[];
	onFocusComposer: () => void;
	onSubmit: (draft: ComposerDraft, mode: "steer" | "followUp") => Promise<void>;
	onStop: () => void;
	onToast: (message: string) => void;
};

export const Composer = forwardRef<ComposerHandle, Props>(function Composer(props, ref) {
	const editor = useRef<HTMLDivElement>(null);
	const attachments = useRef(new Map<string, DraftImage | DraftFile>());
	const [empty, setEmpty] = useState(true);
	const [busy, setBusy] = useState(false);
	const [mention, setMention] = useState<{ query: string } | null>(null);
	const [commandQuery, setCommandQuery] = useState<string | null>(null);
	const [commandActive, setCommandActive] = useState(0);
	const [hits, setHits] = useState<MentionFile[]>([]);
	const [active, setActive] = useState(0);
	const [searching, setSearching] = useState(false);
	const [imageCount, setImageCount] = useState(0);
	const canSend = !empty && !props.disabled && !busy;
	const showStop = props.running && empty;
	const used = props.contextWindow ? Math.min(100, Math.round((props.contextTokens / props.contextWindow) * 100)) : 0;
	const visionHint = imageCount > 0 && props.acceptsImages === false;
	const effortLabel = props.effortLevels.find((level) => level.id === props.effort)?.label;
	const commandHits = filterSlashCommands(props.commands, commandQuery ?? "").slice(0, props.autocompleteMaxVisible);

	const sync = useCallback(() => {
		const root = editor.current;
		if (!root) return { text: "", images: [] as DraftImage[], files: [] as DraftFile[] };
		const draft = readDraft(root, attachments.current);
		const nextEmpty = !draft.text.replace(/\[#(?:image|file) [^\]]+\]/g, "").trim() && draft.images.length === 0 && draft.files.length === 0;
		if (nextEmpty) clearBlankEditor(root);
		setEmpty(nextEmpty);
		setImageCount(draft.images.length);
		return draft;
	}, []);

	const resize = useCallback(() => {
		const element = editor.current;
		if (!element) return;
		element.style.height = "auto";
		const next = Math.min(160, Math.max(52, element.scrollHeight));
		element.style.height = `${next}px`;
		element.style.overflowY = element.scrollHeight > 160 ? "auto" : "hidden";
	}, []);

	const refresh = useCallback(() => {
		const root = editor.current;
		const draft = sync();
		if (root && !props.disabled) {
			const slash = draft.images.length ? null : slashCommandQuery(draft.text);
			setCommandQuery(slash);
			const found = slash === null ? mentionInEditor(root) : null;
			setMention(found ? { query: found.query } : null);
		} else {
			setCommandQuery(null);
		}
		resize();
	}, [props.disabled, resize, sync]);

	useImperativeHandle(ref, () => ({
		setText(text: string) {
			paintDraft(editor.current, { text, images: [], files: [] }, attachments.current, chipHandlers());
			refresh();
			editor.current?.focus();
		},
		restore(draft: ComposerDraft) {
			paintDraft(editor.current, draft, attachments.current, chipHandlers());
			refresh();
		},
		focus() {
			editor.current?.focus();
		},
	}), [refresh]);

	useLayoutEffect(() => {
		refresh();
	}, [refresh]);

	useEffect(() => setCommandActive(0), [commandQuery]);

	useEffect(() => {
		if (!mention || props.disabled) {
			setHits([]);
			setSearching(false);
			return;
		}
		let ignore = false;
		setSearching(true);
		const timer = window.setTimeout(() => {
			void props.controller.searchFiles(mention.query).then((files) => {
				if (ignore) return;
				setHits(files);
				setActive(0);
				setSearching(false);
			}).catch(() => {
				if (!ignore) setSearching(false);
			});
		}, 40);
		return () => {
			ignore = true;
			window.clearTimeout(timer);
		};
	}, [mention?.query, mention, props.controller, props.disabled]);

	const chipHandlers = () => ({
		onOpenFile: (path: string) => {
			void props.controller.openWorkspaceFile(path).catch((error) => {
				props.onToast(error instanceof Error ? error.message : String(error));
			});
		},
		onPreviewImage: (image: DraftImage) => {
			void previewImageInAcode(image).catch((error) => {
				props.onToast(error instanceof Error ? error.message : String(error));
			});
		},
		onOpenAttachment: (file: DraftFile) => {
			if (!file.uri) {
				props.onToast("The original file location is unavailable for this restored attachment.");
				return;
			}
			void openAcodeUri(file.uri, file.name).catch((error) => {
				props.onToast(error instanceof Error ? error.message : String(error));
			});
		},
		onRemoveChip: (chip: HTMLElement) => {
			removeChipElement(chip, attachments.current);
			refresh();
		},
	});

	const insertFile = (file: MentionFile) => {
		const root = editor.current;
		if (!root) return;
		consumeMention(root);
		insertChip(root, createFileChip(file.path, chipHandlers()));
		consumeMention(root);
		setMention(null);
		setHits([]);
		sync();
		resize();
		root.focus();
	};

	const insertCommand = (command: SlashCommand) => {
		paintDraft(editor.current, { text: `/${command.name} `, images: [], files: [] }, attachments.current, chipHandlers());
		setCommandQuery(null);
		setCommandActive(0);
		refresh();
		editor.current?.focus();
	};

	const addDraftImages = (next: DraftImage[]) => {
		const root = editor.current;
		if (!root || !next.length) return;
		for (const image of next) {
			attachments.current.set(image.id, image);
			insertChip(root, createImageChip(image, chipHandlers()));
		}
		refresh();
		root.focus();
	};

	const addDraftFile = (file: DraftFile) => {
		const root = editor.current;
		if (!root) return;
		attachments.current.set(file.id, file);
		insertChip(root, createAttachedFileChip(file, chipHandlers()));
		refresh();
		root.focus();
	};

	const pickImage = async () => {
		if (props.disabled || busy) return;
		setBusy(true);
		try {
			const image = await pickDeviceImage(props.controller.settings.value.imageAutoResize);
			if (image) addDraftImages([image]);
		} catch (error) {
			props.onToast(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	};

	const pickFile = async () => {
		if (props.disabled || busy) return;
		setBusy(true);
		try {
			const file = await pickAcodeFile(props.controller.settings.value.imageAutoResize);
			if (file && "content" in file) addDraftFile(file);
			else if (file) addDraftImages([file]);
		} catch (error) {
			props.onToast(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	};

	const chooseAttachment = async () => {
		if (props.disabled || busy) return;
		const choice = await pickAcodeSelect("Attach", [
			{ value: "image", text: "Image", icon: "image" },
			{ value: "file", text: "File", icon: "document-text" },
		]);
		if (choice === "image") await pickImage();
		if (choice === "file") await pickFile();
	};

	const addFiles = async (files: File[]) => {
		const chosen = files.filter((file) => file.type.startsWith("image/"));
		if (!chosen.length) {
			if (files.length) props.onToast("Choose an image file.");
			return;
		}
		setBusy(true);
		try {
			const next: DraftImage[] = [];
			for (const file of chosen) {
				const image = await imageContentFromFile(file, file.name || "image", props.controller.settings.value.imageAutoResize);
				next.push({ ...image, id: newId(), name: file.name || "image" });
			}
			addDraftImages(next);
		} catch (error) {
			props.onToast(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	};

	const submit = async (mode: "steer" | "followUp") => {
		const root = editor.current;
		if (!root || !canSend) return;
		const draft = readDraft(root, attachments.current);
		if (!draft.text.trim() && !draft.images.length && !draft.files.length) return;
		paintDraft(root, { text: "", images: [], files: [] }, attachments.current, chipHandlers());
		refresh();
		try {
			await props.onSubmit(draft, mode);
		} catch {
			paintDraft(root, draft, attachments.current, chipHandlers());
			refresh();
		}
	};

	const startMention = () => {
		const root = editor.current;
		if (!root || props.disabled) return;
		root.focus();
		insertText(root, "@");
		const found = mentionInEditor(root);
		setMention({ query: found?.query ?? "" });
		sync();
		resize();
	};

	return (
		<footer class="composer">
			<div class="composer-dock">
				{commandQuery !== null && !props.disabled && (
					<CommandMenu
						query={commandQuery}
						commands={commandHits}
						active={commandActive}
						onHover={setCommandActive}
						onPick={insertCommand}
					/>
				)}
				{mention && !props.disabled && (
					<MentionMenu
						query={mention.query}
						hits={hits}
						active={active}
						searching={searching}
						onHover={setActive}
						onPick={insertFile}
					/>
				)}
				{props.queued.length > 0 && (
					<div class="queue-list" aria-label="Queued prompts">
						{props.queued.map((item, index) => (
							<span class={`queue-chip ${item.mode}`} key={`${item.mode}-${index}`}>
								{item.mode === "followUp" ? "After" : "Steer"}
								{" "}
								{item.text || (item.images ? `${item.images} image${item.images === 1 ? "" : "s"}` : "")}
							</span>
						))}
					</div>
				)}
				<div class="composer-field">
					{empty && (
						<span class="composer-placeholder">
							{props.disabled ? "Open a folder to begin" : props.running ? "Steer now, or queue a follow-up…" : "Ask anything…  / commands  @ files"}
						</span>
					)}
				<div
					ref={editor}
					class="composer-input"
					contentEditable={!props.disabled}
					role="textbox"
					aria-multiline="true"
					aria-label="Message"
					inputMode="text"
					enterkeyhint="enter"
					spellcheck={false}
					onInput={refresh}
					onKeyUp={refresh}
					onCompositionEnd={refresh}
					onBeforeInput={(event) => {
						const inputType = (event as unknown as { inputType?: string }).inputType;
						if (inputType !== "deleteContentBackward" && inputType !== "deleteContentForward") return;
						if (tryDeleteChip(editor.current, attachments.current, inputType === "deleteContentForward" ? "forward" : "backward")) {
							event.preventDefault();
							refresh();
						}
					}}
					onTouchStart={() => props.onFocusComposer()}
					onFocus={(event) => {
						if (editor.current && isBlankEditor(editor.current)) clearBlankEditor(editor.current);
						props.onFocusComposer();
						keepPagePinned(event.currentTarget);
					}}
					onPaste={(event) => {
						const files = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith("image/"));
						const text = event.clipboardData?.getData("text/plain") ?? "";
						if (!files.length && !text) return;
						event.preventDefault();
						if (text) insertText(editor.current, text);
						if (files.length) void addFiles(files);
						refresh();
					}}
					onDragOver={(event) => {
						if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
					}}
					onDrop={(event) => {
						const files = [...(event.dataTransfer?.files ?? [])];
						if (!files.length) return;
						event.preventDefault();
						void addFiles(files);
					}}
					onKeyDown={(event) => {
						if (event.isComposing || event.keyCode === 229) return;
						if (commandQuery !== null) {
							if (event.key === "ArrowDown" && commandHits.length) {
								event.preventDefault();
								setCommandActive((index) => (index + 1) % commandHits.length);
								return;
							}
							if (event.key === "ArrowUp" && commandHits.length) {
								event.preventDefault();
								setCommandActive((index) => (index - 1 + commandHits.length) % commandHits.length);
								return;
							}
							if ((event.key === "Enter" || event.key === "Tab") && commandHits[commandActive]) {
								event.preventDefault();
								insertCommand(commandHits[commandActive]!);
								return;
							}
							if (event.key === "Escape") {
								event.preventDefault();
								setCommandQuery(null);
								return;
							}
						}
						if (mention && (hits.length || searching)) {
							if (event.key === "ArrowDown" && hits.length) {
								event.preventDefault();
								setActive((index) => (index + 1) % hits.length);
								return;
							}
							if (event.key === "ArrowUp" && hits.length) {
								event.preventDefault();
								setActive((index) => (index - 1 + hits.length) % hits.length);
								return;
							}
							if ((event.key === "Enter" || event.key === "Tab") && hits[active]) {
								event.preventDefault();
								insertFile(hits[active]!);
								return;
							}
							if (event.key === "Escape") {
								event.preventDefault();
								setMention(null);
								return;
							}
						}
						if (event.key === "Backspace" || event.key === "Delete") {
							if (tryDeleteChip(editor.current, attachments.current, event.key === "Delete" ? "forward" : "backward")) {
								event.preventDefault();
								refresh();
								return;
							}
						}
						if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && canSend) {
							event.preventDefault();
							void submit(event.shiftKey ? "followUp" : "steer");
						}
					}}
				/>
				</div>
				{visionHint && <p class="composer-hint">This model is not marked for image input. Switch to a vision model if needed.</p>}
				<div class="composer-toolbar">
					<button
						class="composer-tool"
						type="button"
						disabled={props.disabled || busy}
						onMouseDown={(event) => event.preventDefault()}
						onClick={() => void chooseAttachment()}
						aria-label="Attach"
					>
						<Paperclip size={16} strokeWidth={2} aria-hidden="true" />
					</button>
					<button
						class="composer-tool"
						type="button"
						disabled={props.disabled}
						onMouseDown={(event) => event.preventDefault()}
						onClick={startMention}
						aria-label="Mention a file"
					>
						<AtSign size={16} strokeWidth={2} aria-hidden="true" />
					</button>
					<button class="config-chip" type="button" onClick={props.onOpenConfig} aria-label="Session configuration">
						<Settings size={16} strokeWidth={2} aria-hidden="true" />
						<span class="mode">{PERMISSION_MODES.find((mode) => mode.id === props.permissionMode)?.label ?? "Ask"}</span>
						{effortLabel && (
							<>
								<span class="sep">·</span>
								<span class="effort">{effortLabel}</span>
							</>
						)}
						<span class="sep">·</span>
						<span class="model">{props.modelName}</span>
					</button>
					{props.contextWindow ? (
						<span
							class={`context-meter${used >= 90 ? " danger" : used >= 70 ? " warn" : ""}`}
							style={{ "--used": `${used}%` } as Record<string, string>}
							title={`${formatTokens(props.contextTokens)} of ${formatTokens(props.contextWindow)}`}
							aria-label="Context window"
						/>
					) : null}
					{showStop ? (
						<button class="composer-action stop" type="button" onClick={props.onStop} aria-label="Stop generation">
							<Square size={16} strokeWidth={2.4} aria-hidden="true" />
						</button>
					) : (
						<>
							{props.running && (
								<button class="composer-action follow" type="button" onClick={() => void submit("followUp")} disabled={!canSend} aria-label="Queue follow-up">
									<ListPlus size={16} strokeWidth={2} aria-hidden="true" />
								</button>
							)}
							<button class="composer-action send" type="button" onClick={() => void submit("steer")} disabled={!canSend} aria-label={props.running ? "Steer agent" : "Send"}>
								<Send size={16} strokeWidth={2} aria-hidden="true" />
							</button>
						</>
					)}
				</div>
			</div>
		</footer>
	);
});

function CommandMenu({
	query,
	commands,
	active,
	onHover,
	onPick,
}: {
	query: string;
	commands: SlashCommand[];
	active: number;
	onHover: (index: number) => void;
	onPick: (command: SlashCommand) => void;
}) {
	return (
		<div class="mention-menu command-menu" role="listbox" aria-label="Slash commands">
			{commands.length === 0 ? (
				<p class="mention-empty">No commands match “{query}”.</p>
			) : commands.map((command, index) => (
				<button
					type="button"
					role="option"
					aria-selected={index === active}
					class={`mention-row command-row${index === active ? " active" : ""}`}
					key={`${command.source}:${command.name}`}
					onMouseDown={(event) => event.preventDefault()}
					onMouseEnter={() => onHover(index)}
					onClick={() => onPick(command)}
				>
					<span class={`command-glyph ${command.source}`} aria-hidden="true">/</span>
					<span class="mention-name">{highlightMatch(command.name, query)}</span>
					<span class="mention-dir">{command.description}</span>
					{command.source !== "action" && <span class={`command-source ${command.source}`}>{command.source}</span>}
				</button>
			))}
		</div>
	);
}

function MentionMenu({
	query,
	hits,
	active,
	searching,
	onHover,
	onPick,
}: {
	query: string;
	hits: MentionFile[];
	active: number;
	searching: boolean;
	onHover: (index: number) => void;
	onPick: (file: MentionFile) => void;
}) {
	return (
		<div class="mention-menu" role="listbox" aria-label="Workspace files">
			{hits.length === 0 ? (
				<p class="mention-empty">{searching ? "Searching files…" : query ? `No files match “${query}”.` : "Type to search files."}</p>
			) : (
				hits.map((file, index) => (
					<button
						type="button"
						role="option"
						aria-selected={index === active}
						class={`mention-row${index === active ? " active" : ""}`}
						key={file.path}
						onMouseDown={(event) => event.preventDefault()}
						onMouseEnter={() => onHover(index)}
						onClick={() => onPick(file)}
					>
						<span class={`file-glyph ${fileIconClass(file.name)}`} aria-hidden="true" />
						<span class="mention-name">{highlightMatch(file.name, query)}</span>
						{fileDir(file.path) && <span class="mention-dir">{fileDir(file.path)}</span>}
					</button>
				))
			)}
		</div>
	);
}

function highlightMatch(text: string, query: string) {
	const needle = query.trim();
	if (!needle) return text;
	const index = text.toLowerCase().indexOf(needle.toLowerCase());
	if (index < 0) return text;
	return (
		<>
			{text.slice(0, index)}
			<mark>{text.slice(index, index + needle.length)}</mark>
			{text.slice(index + needle.length)}
		</>
	);
}

export function UserMessage({
	parts,
	text,
	onOpenFile,
	onPreviewImage,
}: {
	parts?: UserPart[];
	text?: string;
	onOpenFile?: (path: string) => void;
	onPreviewImage?: (image: Extract<UserPart, { type: "image" }>) => void;
}) {
	const items = parts?.length ? parts : text ? splitUserText(text) : [];
	if (!items.length) return null;
	return (
		<article class="bubble user">
			<div class="user-body">
				{items.map((part, index) => {
					if (part.type === "file") {
						return (
							<button
								class="mention-chip chip-file in-bubble"
								type="button"
								title={part.path}
								key={`${part.path}-${index}`}
								onClick={() => onOpenFile?.(part.path)}
							>
								<FileChipFace path={part.path} />
							</button>
						);
					}
					if (part.type === "attachment") {
						return (
							<span class="mention-chip chip-file chip-attachment in-bubble" title="Attached file" key={`attachment-${part.name}-${index}`}>
								<FileChipFace path={part.name} />
							</span>
						);
					}
					if (part.type === "image" || part.type === "imageRef") {
						const name = part.type === "image" ? part.name || "image" : part.name;
						return (
							<button
								class="mention-chip chip-image in-bubble"
								type="button"
								title={name}
								key={`image-${index}`}
								onClick={() => {
									if (part.type === "image") onPreviewImage?.(part);
								}}
							>
								{part.type === "image" && <img class="chip-thumb" src={imageSrc(part)} alt="" />}
								<span class="chip-name">{name}</span>
							</button>
						);
					}
					return <span class="user-text" key={`text-${index}`}>{part.text}</span>;
				})}
			</div>
		</article>
	);
}

function readDraft(root: HTMLElement, store: Map<string, DraftImage | DraftFile>): ComposerDraft {
	const chunks: string[] = [];
	const attached: DraftImage[] = [];
	const files: DraftFile[] = [];
	const walk = (node: Node) => {
		if (node.nodeType === Node.TEXT_NODE) {
			chunks.push(node.textContent ?? "");
			return;
		}
		if (!(node instanceof HTMLElement)) {
			node.childNodes.forEach(walk);
			return;
		}
		if (node.dataset.chip === "file" && node.dataset.path) {
			chunks.push(`@${node.dataset.path}`);
			return;
		}
		if (node.dataset.chip === "image" && node.dataset.id) {
			const image = store.get(node.dataset.id);
			if (image && "type" in image && image.type === "image") {
				attached.push(image);
				chunks.push(imagePlaceholder(image.name));
			}
			return;
		}
		if (node.dataset.chip === "attachment" && node.dataset.id) {
			const file = store.get(node.dataset.id);
			if (file && !("type" in file)) {
				files.push(file);
				chunks.push(filePlaceholder(file.name));
			}
			return;
		}
		if (node.tagName === "BR") {
			chunks.push("\n");
			return;
		}
		node.childNodes.forEach(walk);
		if (node.tagName === "DIV" || node.tagName === "P") chunks.push("\n");
	};
	root.childNodes.forEach(walk);
	return { text: chunks.join("").replace(/\n+$/, ""), images: attached, files };
}

type ChipHandlers = {
	onOpenFile: (path: string) => void;
	onPreviewImage: (image: DraftImage) => void;
	onOpenAttachment: (file: DraftFile) => void;
	onRemoveChip: (chip: HTMLElement) => void;
};

function paintDraft(
	root: HTMLElement | null,
	draft: ComposerDraft,
	store: Map<string, DraftImage | DraftFile>,
	handlers: ChipHandlers,
): void {
	if (!root) return;
	root.replaceChildren();
	store.clear();
	const unused = [...draft.images];
	const unusedFiles = [...draft.files];
	for (const part of splitUserText(draft.text)) {
		if (part.type === "text") {
			root.append(document.createTextNode(part.text));
			continue;
		}
		if (part.type === "file") {
			root.append(createFileChip(part.path, handlers));
			continue;
		}
		if (part.type === "attachment") {
			const file = unusedFiles.shift();
			if (!file) continue;
			store.set(file.id, file);
			root.append(createAttachedFileChip(file, handlers));
			continue;
		}
		const image = unused.shift();
		if (!image) continue;
		store.set(image.id, image);
		root.append(createImageChip(image, handlers));
	}
	for (const image of unused) {
		store.set(image.id, image);
		root.append(createImageChip(image, handlers));
	}
	for (const file of unusedFiles) {
		store.set(file.id, file);
		root.append(createAttachedFileChip(file, handlers));
	}
	setCaret(root, root, root.childNodes.length);
}

function FileChipFace({ path }: { path: string }) {
	return (
		<>
			<span class={`file-glyph ${fileIconClass(fileName(path))}`} aria-hidden="true" />
			<span class="chip-name">{fileName(path)}</span>
		</>
	);
}

function createFileChip(path: string, handlers: ChipHandlers): HTMLSpanElement {
	const chip = document.createElement("span");
	chip.className = "mention-chip chip-file chip-attachment";
	chip.dataset.chip = "file";
	chip.dataset.path = path;
	chip.contentEditable = "false";
	chip.title = path;
	const name = document.createElement("span");
	name.className = "chip-name";
	name.textContent = fileName(path);
	chip.append(createFileGlyph(path), name);
	chip.addEventListener("mousedown", (event) => event.preventDefault());
	chip.addEventListener("click", () => handlers.onOpenFile(path));
	return chip;
}

function createAttachedFileChip(file: DraftFile, handlers: ChipHandlers): HTMLSpanElement {
	const chip = document.createElement("span");
	chip.className = "mention-chip chip-file";
	chip.dataset.chip = "attachment";
	chip.dataset.id = file.id;
	chip.contentEditable = "false";
	chip.title = file.name;
	const name = document.createElement("span");
	name.className = "chip-name";
	name.textContent = file.name;
	chip.append(createFileGlyph(file.name), name);
	chip.addEventListener("mousedown", (event) => event.preventDefault());
	chip.addEventListener("click", () => handlers.onOpenAttachment(file));
	return chip;
}

function createImageChip(image: DraftImage, handlers: ChipHandlers): HTMLSpanElement {
	const chip = document.createElement("span");
	chip.className = "mention-chip chip-image";
	chip.dataset.chip = "image";
	chip.dataset.id = image.id;
	chip.contentEditable = "false";
	chip.title = image.name;
	const thumb = document.createElement("img");
	thumb.className = "chip-thumb";
	thumb.alt = "";
	thumb.src = imageSrc(image);
	const name = document.createElement("span");
	name.className = "chip-name";
	name.textContent = image.name;
	chip.append(thumb, name);
	chip.addEventListener("mousedown", (event) => event.preventDefault());
	chip.addEventListener("click", () => handlers.onPreviewImage(image));
	return chip;
}

function insertChip(root: HTMLElement, chip: HTMLElement): void {
	insertNodes(root, [chip, document.createTextNode("\u00a0")]);
}

function insertText(root: HTMLElement | null, text: string): void {
	if (!root) return;
	insertNodes(root, [document.createTextNode(text)]);
}

function insertNodes(root: HTMLElement, nodes: Node[]): void {
	root.focus();
	const selection = getEditorSelection(root);
	const inTree = Boolean(selection?.anchorNode && root.contains(selection.anchorNode));
	const range = inTree && selection!.rangeCount
		? selection!.getRangeAt(0)
		: (() => {
			const next = root.ownerDocument.createRange();
			next.selectNodeContents(root);
			next.collapse(false);
			return next;
		})();
	range.deleteContents();
	for (const node of [...nodes].reverse()) range.insertNode(node);
	range.collapse(false);
	try {
		selection?.removeAllRanges();
		selection?.addRange(range);
	} catch {
		setCaret(root, nodes[nodes.length - 1] ?? root, nodes[nodes.length - 1]?.nodeType === Node.TEXT_NODE ? (nodes[nodes.length - 1] as Text).length : 0);
	}
}

function tryDeleteChip(root: HTMLElement | null, store: Map<string, DraftImage | DraftFile>, direction: "backward" | "forward"): boolean {
	if (!root) return false;
	const chip = chipBesideCaret(root, direction);
	if (!chip) return false;
	removeChipElement(chip, store);
	return true;
}

function chipBesideCaret(root: HTMLElement, direction: "backward" | "forward"): HTMLElement | null {
	const selection = getEditorSelection(root);
	if (!selection?.anchorNode || !root.contains(selection.anchorNode)) {
		const chips = [...root.querySelectorAll<HTMLElement>("[data-chip]")];
		return direction === "backward" ? chips.at(-1) ?? null : chips[0] ?? null;
	}
	const { anchorNode, anchorOffset } = selection;
	if (anchorNode instanceof HTMLElement && anchorNode.dataset.chip) return anchorNode;
	if (anchorNode.nodeType === Node.TEXT_NODE) {
		const atEdge = direction === "backward" ? anchorOffset === 0 : anchorOffset === (anchorNode.textContent?.length ?? 0);
		const onlySpace = /^[\u00a0\s]*$/.test(anchorNode.textContent ?? "");
		if (atEdge || onlySpace) {
			const sibling = adjacentElement(anchorNode, direction);
			if (sibling?.dataset.chip) return sibling;
		}
	}
	if (anchorNode === root || (anchorNode instanceof HTMLElement && !anchorNode.dataset.chip)) {
		const index = direction === "backward" ? anchorOffset - 1 : anchorOffset;
		const child = anchorNode.childNodes[index];
		if (child instanceof HTMLElement && child.dataset.chip) return child;
		if (child?.nodeType === Node.TEXT_NODE) {
			const sibling = adjacentElement(child, direction);
			if (sibling?.dataset.chip) return sibling;
		}
	}
	return null;
}

function adjacentElement(node: Node, direction: "backward" | "forward"): HTMLElement | null {
	let current: Node | null = node;
	while (current) {
		const sibling: ChildNode | null = direction === "backward" ? current.previousSibling : current.nextSibling;
		if (sibling instanceof HTMLElement) return sibling;
		if (sibling?.nodeType === Node.TEXT_NODE && /^[\u00a0\s]*$/.test(sibling.textContent ?? "")) {
			current = sibling;
			continue;
		}
		if (sibling) return sibling instanceof HTMLElement ? sibling : null;
		current = current.parentNode;
		if (current instanceof HTMLElement && current.classList.contains("composer-input")) return null;
		if (current instanceof HTMLElement && current.dataset.chip) return current;
	}
	return null;
}

function removeChipElement(chip: HTMLElement, store: Map<string, DraftImage | DraftFile>): void {
	const id = chip.dataset.id;
	if (id) store.delete(id);
	const next = chip.nextSibling;
	const prev = chip.previousSibling;
	if (next?.nodeType === Node.TEXT_NODE && /^[\u00a0\s]?$/.test(next.textContent ?? "")) next.remove();
	const parent = chip.parentElement;
	chip.remove();
	if (parent) setCaret(parent.closest(".composer-input") ?? parent, prev ?? parent, prev?.nodeType === Node.TEXT_NODE ? (prev.textContent?.length ?? 0) : 0);
}

function keepPagePinned(from: HTMLElement) {
	const pin = () => {
		const host = from.closest(".acode-agent-root");
		if (host instanceof HTMLElement) host.scrollTop = 0;
		if (host?.parentElement) host.parentElement.scrollTop = 0;
		const root = from.getRootNode();
		if (root instanceof ShadowRoot && root.host instanceof HTMLElement) root.host.scrollTop = 0;
		window.scrollTo(0, 0);
	};
	pin();
	requestAnimationFrame(pin);
}

function formatTokens(tokens: number): string {
	return tokens >= 1000 ? `${(tokens / 1000).toFixed(tokens >= 10_000 ? 0 : 1)}k tokens` : `${tokens} tokens`;
}

function newId(): string {
	return globalThis.crypto?.randomUUID?.() ?? `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
