import { useEffect, useRef } from "preact/hooks";
import plugin from "../../plugin.json";

let nextId = 0;

export function getActionStack(): Acode.ActionStack | null {
	try {
		if (typeof acode === "undefined" || typeof acode.require !== "function") return null;
		const stack = acode.require("actionStack");
		if (!stack || typeof stack.push !== "function" || typeof stack.remove !== "function") return null;
		return stack;
	} catch {
		return null;
	}
}

/** Push a back-button handler. The returned function removes it without running it. */
export function pushBackAction(id: string, action: () => void): () => void {
	const stack = getActionStack();
	if (!stack) return () => undefined;
	stack.push({ id, action });
	return () => {
		stack.remove(id);
	};
}

export function backActionId(kind: string, unique = false): string {
	if (!unique) return `${plugin.id}:${kind}`;
	nextId += 1;
	return `${plugin.id}:${kind}:${nextId}`;
}

/**
 * Register `action` on Acode's action stack while mounted (and `enabled`).
 * Android back then runs `action` instead of closing the app.
 */
export function useBackAction(id: string, action: () => void, enabled = true): void {
	const actionRef = useRef(action);
	actionRef.current = action;

	useEffect(() => {
		if (!enabled) return;
		return pushBackAction(id, () => actionRef.current());
	}, [id, enabled]);
}
