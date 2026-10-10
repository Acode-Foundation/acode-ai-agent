import { beforeEach, expect, test, vi } from "vitest";

const motion = vi.hoisted(() => ({ play: vi.fn(async () => {}), stop: vi.fn() }));
vi.mock("../src/ui/motion", () => ({ playMotion: motion.play, stopMotion: motion.stop }));
import { bindSheetDrag } from "../src/ui/sheetDrag";

function fixture() {
  const captured = new Set<number>();
  const classes = new Set<string>();
  const sheet = Object.assign(new EventTarget(), {
    style: { transform: "" },
    classList: {
      add: (value: string) => classes.add(value),
      remove: (value: string) => classes.delete(value),
    },
    setPointerCapture: (id: number) => captured.add(id),
    releasePointerCapture: (id: number) => captured.delete(id),
    hasPointerCapture: (id: number) => captured.has(id),
  });
  const close = vi.fn();
  const remove = bindSheetDrag(sheet as unknown as HTMLElement, close);
  const send = (
    type: string,
    y = 0,
    options: { zone?: string; pointerId?: number; button?: number; isPrimary?: boolean } = {},
  ) => {
    const zone = options.zone ?? "handle";
    const event = new Event(type, { cancelable: true });
    Object.defineProperties(event, {
      target: {
        value: {
          closest: (selector: string) =>
            selector === ".sheet-handle"
              ? zone === "handle"
              : selector === ".sheet-header"
                ? zone === "header" || zone === "button"
                : zone === "button",
        },
      },
      pointerId: { value: options.pointerId ?? 1 },
      isPrimary: { value: options.isPrimary ?? true },
      button: { value: options.button ?? 0 },
      clientY: { value: y },
    });
    sheet.dispatchEvent(event);
    return event;
  };
  return { sheet, close, remove, send, captured, classes };
}

beforeEach(() => vi.clearAllMocks());

test("pulling the handle by 100px dismisses once and consumes the drag click", () => {
  const { sheet, close, send, captured, classes } = fixture();
  send("pointerdown", 20);
  expect(captured.has(1)).toBe(true);
  send("pointermove", 120);
  expect(sheet.style.transform).toBe("translateY(100px)");
  send("pointerup", 120);
  send("pointerup", 120);
  expect(send("click").defaultPrevented).toBe(true);
  expect(close).toHaveBeenCalledOnce();
  expect(captured.size).toBe(0);
  expect(classes.has("dragging")).toBe(false);
});

test("a short header pull snaps back and does not turn into a close click", () => {
  const { close, send } = fixture();
  send("pointerdown", 30, { zone: "header" });
  send("pointerup", 100, { zone: "header" });
  send("click", 0, { zone: "header" });
  expect(close).not.toHaveBeenCalled();
  expect(motion.play).toHaveBeenCalledWith(
    expect.anything(),
    { transform: "translateY(0px)" },
    expect.anything(),
  );
});

test("upward pulls are clamped and another pointer cannot move the sheet", () => {
  const { sheet, close, send } = fixture();
  send("pointerdown", 150);
  send("pointermove", 350, { pointerId: 2 });
  expect(sheet.style.transform).toBe("translateY(0px)");
  send("pointermove", 50);
  expect(sheet.style.transform).toBe("translateY(0px)");
  send("pointerup", 50);
  expect(close).not.toHaveBeenCalled();
});

test.each(["pointercancel", "lostpointercapture"])(
  "%s resets even a long pull without dismissing",
  (type) => {
    const { close, send, classes } = fixture();
    send("pointerdown", 20);
    send("pointermove", 220);
    send(type, 220);
    expect(close).not.toHaveBeenCalled();
    expect(classes.has("dragging")).toBe(false);
    expect(motion.play).toHaveBeenCalledOnce();
  },
);

test("content, header buttons, secondary pointers, and right clicks do not start dragging", () => {
  const { sheet, send, captured } = fixture();
  for (const options of [
    { zone: "body" },
    { zone: "button" },
    { isPrimary: false },
    { button: 2 },
  ]) {
    send("pointerdown", 20, options);
    send("pointermove", 220, options);
  }
  expect(captured.size).toBe(0);
  expect(sheet.style.transform).toBe("");
  expect(motion.stop).not.toHaveBeenCalled();
});

test("cleanup releases an active pointer and disables later movement and dismissal", () => {
  const { sheet, close, send, remove, captured } = fixture();
  send("pointerdown", 20);
  send("pointermove", 60);
  remove();
  send("pointermove", 220);
  send("pointerup", 220);
  send("click");
  expect(sheet.style.transform).toBe("translateY(40px)");
  expect(captured.size).toBe(0);
  expect(close).not.toHaveBeenCalled();
});

test("tapping or keyboard-activating the handle remains an accessible close action", () => {
  const { close, send } = fixture();
  send("click");
  expect(close).toHaveBeenCalledOnce();
});

test("a captured handle tap dismisses even when pointerup and click target the sheet", () => {
  const { close, send } = fixture();
  send("pointerdown", 20);
  send("pointerup", 20, { zone: "body" });
  send("click", 20, { zone: "body" });
  expect(close).toHaveBeenCalledOnce();
});
