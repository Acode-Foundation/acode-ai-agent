import type { ComponentChildren } from "preact";
import { useCallback, useEffect, useLayoutEffect, useRef } from "preact/hooks";
import { backActionId, useBackAction } from "./actionStack";
import { enterSheet, exitSheet, stopMotion } from "./motion";
import { bindSheetDrag } from "./sheetDrag";

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
  const removeDrag = useRef<() => void>(() => undefined);
  const backId = useRef("");
  if (!backId.current) backId.current = backActionId("sheet", true);

  const close = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    removeDrag.current();
    const dim = dimRef.current;
    const sheet = sheetRef.current;
    if (!dim || !sheet) {
      onClose();
      return;
    }
    void exitSheet(dim, sheet).then(onClose);
  }, [onClose]);
  const closeRef = useRef(close);
  closeRef.current = close;

  useBackAction(backId.current, close);

  useLayoutEffect(() => {
    const root = sheetRef.current?.getRootNode();
    let active =
      root instanceof ShadowRoot
        ? root.activeElement
        : sheetRef.current?.ownerDocument.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    if (active instanceof HTMLElement && !sheetRef.current?.contains(active)) active.blur();
  }, []);

  useEffect(() => {
    const dim = dimRef.current;
    const sheet = sheetRef.current;
    if (!dim || !sheet) return;
    void enterSheet(dim, sheet);
    removeDrag.current = bindSheetDrag(sheet, () => closeRef.current());
    return () => {
      removeDrag.current();
      stopMotion(dim);
      stopMotion(sheet);
    };
  }, []);

  return (
    <div class="sheet-layer">
      <div class="sheet-dim" ref={dimRef} onClick={close} />
      <section
        class={`sheet ${sheetClass}`.trim()}
        ref={sheetRef}
        onClick={(event) => event.stopPropagation()}
      >
        <button class="sheet-handle" type="button" aria-label="Close sheet">
          <span />
        </button>
        {children(close)}
      </section>
    </div>
  );
}
