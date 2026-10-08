import { expect, test, vi } from "vitest";
import {
  createMotionGate,
  readThreadSnapshot,
  scrollTopAfterViewport,
} from "../src/ui/useChatScroll.ts";

test("a thread at the bottom stays pinned after the pane shrinks", () => {
  const before = readThreadSnapshot(2000, 1200, 800);
  expect(before.atEnd).toBe(true);
  expect(scrollTopAfterViewport(before, 2000, 400)).toBe(1600);
});

test("a scrolled-away thread keeps its offset when the pane shrinks", () => {
  const before = readThreadSnapshot(2000, 400, 800);
  expect(before.atEnd).toBe(false);
  expect(before.fromEnd).toBe(800);
  expect(scrollTopAfterViewport(before, 2000, 400)).toBe(400);
});

test("a small scroll away from the latest message is not treated as at-end", () => {
  const before = readThreadSnapshot(2000, 1120, 800);
  expect(before.fromEnd).toBe(80);
  expect(before.atEnd).toBe(false);
  expect(scrollTopAfterViewport(before, 2000, 400)).toBe(1120);
});

test("a collapse animation that never reports its end releases following after the fallback", () => {
  vi.useFakeTimers();
  let idle = 0;
  const gate = createMotionGate(() => idle++, 900);
  const row = new EventTarget();
  gate.start(row);
  // An interrupted animation restarts on the same element without ending the first run.
  gate.start(row);
  expect(gate.busy).toBe(true);
  vi.advanceTimersByTime(899);
  expect(gate.busy).toBe(true);
  vi.advanceTimersByTime(1);
  expect(gate.busy).toBe(false);
  expect(idle).toBe(1);
  vi.useRealTimers();
});

test("following resumes only after every running collapse ends", () => {
  let idle = 0;
  const gate = createMotionGate(() => idle++);
  const first = new EventTarget();
  const second = new EventTarget();
  gate.start(first);
  gate.start(second);
  gate.end(first);
  expect(gate.busy).toBe(true);
  gate.end(first);
  gate.end(second);
  expect(gate.busy).toBe(false);
  expect(idle).toBe(1);
  gate.dispose();
});
