import { afterEach, expect, test } from "vitest";
import { getCodeHighlight, highlightCodeBlocks } from "../src/platform/codeHighlight.ts";

const host = globalThis as typeof globalThis & { acode?: { require: (name: string) => unknown } };

afterEach(() => {
	delete host.acode;
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

function fakeCode(source: string, language: string) {
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
		closest() {
			return { getAttribute: () => language };
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
