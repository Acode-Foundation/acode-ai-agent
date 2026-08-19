import { afterEach, expect, test } from "vitest";
import { backActionId, getActionStack, pushBackAction } from "../src/ui/actionStack.ts";

const host = globalThis as typeof globalThis & { acode?: { require: (name: string) => unknown } };

afterEach(() => {
	delete host.acode;
});

function fakeStack() {
	const items: Array<{ id: string; action: () => void }> = [];
	return {
		items,
		get length() {
			return items.length;
		},
		push(action: { id: string; action: () => void }) {
			items.push(action);
		},
		remove(id: string) {
			const index = items.findIndex((item) => item.id === id);
			if (index < 0) return false;
			items.splice(index, 1);
			return true;
		},
		pop() {
			return items.pop()?.action();
		},
	};
}

test("returns null when Acode action stack is missing", () => {
	expect(getActionStack()).toBeNull();
	host.acode = { require: () => undefined };
	expect(getActionStack()).toBeNull();
});

test("returns the host action stack when Acode exposes it", () => {
	const stack = fakeStack();
	host.acode = {
		require(name) {
			return name === "actionStack" ? stack : undefined;
		},
	};
	expect(getActionStack()).toBe(stack);
});

test("pushBackAction registers a handler and dispose removes it without running it", () => {
	const stack = fakeStack();
	host.acode = {
		require(name) {
			return name === "actionStack" ? stack : undefined;
		},
	};
	let closed = 0;
	const dispose = pushBackAction("sheet", () => {
		closed += 1;
	});
	expect(stack.items).toHaveLength(1);
	expect(stack.items[0]?.id).toBe("sheet");
	dispose();
	expect(stack.items).toHaveLength(0);
	expect(closed).toBe(0);
});

test("back pops the registered handler instead of leaving the stack empty", () => {
	const stack = fakeStack();
	host.acode = {
		require(name) {
			return name === "actionStack" ? stack : undefined;
		},
	};
	let closed = 0;
	pushBackAction("sheet", () => {
		closed += 1;
	});
	stack.pop();
	expect(closed).toBe(1);
	expect(stack.items).toHaveLength(0);
});

test("pushBackAction is a no-op without a host stack", () => {
	expect(pushBackAction("sheet", () => undefined)).toBeTypeOf("function");
	pushBackAction("sheet", () => undefined)();
});

test("backActionId is stable unless unique is requested", () => {
	expect(backActionId("sheet")).toBe("acode.ai.agent:sheet");
	expect(backActionId("sheet", true)).not.toBe(backActionId("sheet", true));
});
