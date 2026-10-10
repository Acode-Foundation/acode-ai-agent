import { playMotion, stopMotion } from "./motion";

/** Match the plugin-review sheet: pull down 100px to dismiss, otherwise snap back. */
export function bindSheetDrag(sheet: HTMLElement, close: () => void): () => void {
  let drag: { pointerId: number; startY: number; distance: number; handle: boolean } | undefined;
  let suppressClick = false;

  const reset = () => {
    drag = undefined;
    sheet.classList.remove("dragging");
  };
  const snapBack = () => {
    void playMotion(sheet, { transform: "translateY(0px)" }, { duration: 0.2, ease: "easeOut" });
  };
  const start = (event: PointerEvent) => {
    if (!drag) suppressClick = false;
    const target = event.target as Element;
    const handle = target.closest(".sheet-handle");
    if (
      drag ||
      !event.isPrimary ||
      event.button !== 0 ||
      (!handle && !target.closest(".sheet-header")) ||
      (!handle && target.closest("button, input, select, textarea, a"))
    )
      return;
    stopMotion(sheet);
    sheet.style.transform = "translateY(0px)";
    suppressClick = false;
    drag = {
      pointerId: event.pointerId,
      startY: event.clientY,
      distance: 0,
      handle: Boolean(handle),
    };
    sheet.classList.add("dragging");
    sheet.setPointerCapture(event.pointerId);
  };
  const move = (event: PointerEvent) => {
    if (drag?.pointerId !== event.pointerId) return;
    if (Math.abs(event.clientY - drag.startY) > 5) suppressClick = true;
    drag.distance = Math.max(0, event.clientY - drag.startY);
    sheet.style.transform = `translateY(${drag.distance}px)`;
  };
  const finish = (event: PointerEvent) => {
    if (drag?.pointerId !== event.pointerId) return;
    move(event);
    // Pointer capture retargets the following click to the sheet, so complete handle taps here.
    const dismiss =
      event.type === "pointerup" && (drag.distance >= 100 || (drag.handle && !suppressClick));
    if (dismiss) suppressClick = true;
    if (event.type === "pointercancel") suppressClick = false;
    reset();
    if (sheet.hasPointerCapture(event.pointerId)) sheet.releasePointerCapture(event.pointerId);
    if (dismiss) close();
    else snapBack();
  };
  const lostCapture = () => {
    if (!drag) return;
    suppressClick = false;
    reset();
    snapBack();
  };
  const click = (event: MouseEvent) => {
    if (suppressClick) {
      suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if ((event.target as Element).closest(".sheet-handle")) close();
  };

  sheet.addEventListener("pointerdown", start);
  sheet.addEventListener("pointermove", move);
  sheet.addEventListener("pointerup", finish);
  sheet.addEventListener("pointercancel", finish);
  sheet.addEventListener("lostpointercapture", lostCapture);
  sheet.addEventListener("click", click, true);
  return () => {
    const pointerId = drag?.pointerId;
    reset();
    sheet.removeEventListener("pointerdown", start);
    sheet.removeEventListener("pointermove", move);
    sheet.removeEventListener("pointerup", finish);
    sheet.removeEventListener("pointercancel", finish);
    sheet.removeEventListener("lostpointercapture", lostCapture);
    sheet.removeEventListener("click", click, true);
    if (pointerId !== undefined && sheet.hasPointerCapture(pointerId))
      sheet.releasePointerCapture(pointerId);
  };
}
