import { afterEach, expect, test } from "vitest";
import { clearCodeHighlightCache, getCodeHighlight, highlightCodeBlocks } from "../src/platform/codeHighlight.ts";

const host = globalThis as typeof globalThis & { acode?: { require: (name: string) => unknown } };

afterEach(() => {
	delete host.acode;
	clearCodeHighlightCache();
});

test("returns null when the host highlighter is missing", () => {
	expect(getCodeHighlight()).toBeNull();
	host.acode = { require: () => undefined };
	expect(getCodeHighlight()).toBeNull();
});

test("returns the host highlighter when Acode exposes it", () => {
	const api = {
		highlightCodeBlock: async () => "",
		applyStyles() {},
		HIGHLIGHT_CLASS: "cm-highlighted",
	};
	host.acode = {
		require(name) {
			return name === "codeHighlight" ? api : undefined;
		},
	};
	expect(getCodeHighlight()).toBe(api);
});

test("leaves fenced code unchanged when highlighting is unavailable", async () => {
	const code = fakeCode("const x = 1;", "ts");
	await highlightCodeBlocks(fakeRoot([code]));
	expect(code.innerHTML).toBe("");
	expect(code.dataset.cmHighlighted).toBeUndefined();
});

test("highlights fenced blocks when the host API exists", async () => {
	const code = fakeCode("const x = 1;", "ts");
	const applied: unknown[] = [];
	host.acode = {
		require(name) {
			if (name !== "codeHighlight") return undefined;
			return {
				HIGHLIGHT_CLASS: "cm-highlighted",
				applyStyles(root: unknown) {
					applied.push(root);
				},
				async highlightCodeBlock(source: string, language?: string | null) {
					expect(source).toBe("const x = 1;");
					expect(language).toBe("ts");
					return '<span class="tok-keyword">const</span> x = 1;';
				},
			};
		},
	};

	await highlightCodeBlocks(fakeRoot([code]));
	expect(code.innerHTML).toBe('<span class="tok-keyword">const</span> x = 1;');
	expect(code.classList.added).toContain("cm-highlighted");
	expect(code.closest("pre")?.classList.added).toContain("cm-highlighted");
	expect(code.dataset.cmHighlighted).toBe("1");
	expect(applied).toHaveLength(1);
});

test("keeps escaped source if highlighting throws", async () => {
	const code = fakeCode("const x = 1;", "ts");
	host.acode = {
		require() {
			return {
				async highlightCodeBlock() {
					throw new Error("parser failed");
				},
			};
		},
	};

	await highlightCodeBlocks(fakeRoot([code]));
	expect(code.innerHTML).toBe("");
	expect(code.dataset.cmHighlighted).toBeUndefined();
});

test("skips unclosed fences until they are complete", async () => {
	const calls: string[] = [];
	host.acode = {
		require() {
			return {
				async highlightCodeBlock(source: string) {
					calls.push(source);
					return `<span>${source}</span>`;
				},
			};
		},
	};

	const pending = fakeCode("const x = 1;", "ts", true);
	await highlightCodeBlocks(fakeRoot([pending]));
	expect(calls).toEqual([]);
	expect(pending.innerHTML).toBe("");
	expect(pending.dataset.cmHighlighted).toBeUndefined();
});

test("highlights closed blocks and ignores a trailing pending fence", async () => {
	const calls: string[] = [];
	host.acode = {
		require() {
			return {
				async highlightCodeBlock(source: string) {
					calls.push(source);
					return `<span>${source}</span>`;
				},
			};
		},
	};

	const closed = fakeCode("const a = 1;", "ts");
	const pending = fakeCode("const b = 2;", "js", true);
	await highlightCodeBlocks(fakeRoot([closed, pending]));
	expect(calls).toEqual(["const a = 1;"]);
	expect(closed.innerHTML).toBe("<span>const a = 1;</span>");
	expect(closed.dataset.cmHighlighted).toBe("1");
	expect(pending.innerHTML).toBe("");
	expect(pending.dataset.cmHighlighted).toBeUndefined();
});

test("reuses highlight output for the same closed source", async () => {
	let calls = 0;
	host.acode = {
		require() {
			return {
				async highlightCodeBlock(source: string) {
					calls += 1;
					return `<span>${source}</span>`;
				},
			};
		},
	};

	const first = fakeCode("const reused = 1;", "ts");
	await highlightCodeBlocks(fakeRoot([first]));
	const second = fakeCode("const reused = 1;", "ts");
	await highlightCodeBlocks(fakeRoot([second]));
	expect(calls).toBe(1);
	expect(second.innerHTML).toBe("<span>const reused = 1;</span>");
	expect(second.dataset.cmHighlighted).toBe("1");
});

function fakeCode(source: string, language: string, pending = false) {
	const pre = {
		classList: {
			added: [] as string[],
			add(name: string) {
				this.added.push(name);
			},
		},
	};
	const figure = {
		getAttribute(name: string) {
			return name === "data-lang" ? language : null;
		},
		hasAttribute(name: string) {
			return name === "data-pending" && pending;
		},
	};
	return {
		dataset: {} as Record<string, string>,
		textContent: source,
		isConnected: true,
		innerHTML: "",
		classList: {
			added: [] as string[],
			add(name: string) {
				this.added.push(name);
			},
		},
		closest(selector: string) {
			if (selector === "pre") return pre;
			return figure;
		},
	};
}

function fakeRoot(blocks: ReturnType<typeof fakeCode>[]): ParentNode {
	return {
		querySelectorAll() {
			return blocks;
		},
	} as unknown as ParentNode;
}
