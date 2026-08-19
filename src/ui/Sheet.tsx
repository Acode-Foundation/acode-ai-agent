import type { ComponentChildren } from "preact";
import { useCallback, useEffect, useRef } from "preact/hooks";
import { enterSheet, exitSheet, stopMotion } from "./motion";

export function Sheet({
	onClose,
	class: sheetClass = "",
	children,
}: {
	onClose: () => void;
	class?: string;
	children: (close: () => void) => ComponentChildren;
}) {
	const dimRef = useRef<HTMLDivElement>(null);
	const sheetRef = useRef<HTMLElement>(null);
	const closing = useRef(false);

	const close = useCallback(() => {
		if (closing.current) return;
		closing.current = true;
		const dim = dimRef.current;
		const sheet = sheetRef.current;
		if (!dim || !sheet) {
			onClose();
			return;
		}
		void exitSheet(dim, sheet).then(onClose);
	}, [onClose]);

	useEffect(() => {
		const dim = dimRef.current;
		const sheet = sheetRef.current;
		if (!dim || !sheet) return;
		void enterSheet(dim, sheet);
		return () => {
			stopMotion(dim);
			stopMotion(sheet);
		};
	}, []);

	return (
		<div class="sheet-layer">
			<div class="sheet-dim" ref={dimRef} onClick={close} />
			<section class={`sheet ${sheetClass}`.trim()} ref={sheetRef} onClick={(event) => event.stopPropagation()}>
				{children(close)}
			</section>
		</div>
	);
}
