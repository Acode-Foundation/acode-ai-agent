// @vitest-environment happy-dom
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { expect, onTestFinished, test, vi } from "vitest";
import { Signal } from "../src/core/events";
import type { AgentController } from "../src/app/agentController";
import type { ChatSummary } from "../src/core/types.ts";
import { filterChats, SidebarApp } from "../src/ui/sidebar/SidebarApp.tsx";

const chats: ChatSummary[] = [
  {
    id: "older",
    title: "Fix parser",
    workspaceId: "alpha",
    workspaceName: "Compiler",
    updatedAt: 10,
    running: false,
  },
  {
    id: "newer",
    title: "Build dashboard",
    workspaceId: "beta",
    workspaceName: "Studio",
    updatedAt: 20,
    running: true,
  },
];

test("sorts sidebar sessions by recent activity", () => {
  expect(filterChats(chats, "").map((chat) => chat.id)).toEqual(["newer", "older"]);
});

test("filters sessions by title or workspace", () => {
  expect(filterChats(chats, "parser").map((chat) => chat.id)).toEqual(["older"]);
  expect(filterChats(chats, "studio").map((chat) => chat.id)).toEqual(["newer"]);
  expect(filterChats(chats, "", "alpha").map((chat) => chat.id)).toEqual(["older"]);
});

test("sidebar handles session actions and a canceled or repeated project prompt", async () => {
  let promptOpen = false;
  let submit!: (name: string | null) => void;
  const prompt = vi.fn(() => {
    promptOpen = true;
    return new Promise<string | null>((resolve) => {
      submit = (name) => {
        promptOpen = false;
        resolve(name);
      };
    });
  });
  const toast = vi.fn();
  let answerDelete!: (confirmed: boolean) => void;
  const confirm = vi.fn(() => new Promise<boolean>((resolve) => (answerDelete = resolve)));
  vi.stubGlobal("acode", {
    prompt,
    confirm,
    require: (module: string) => (module === "actionStack" ? { has: () => promptOpen } : toast),
  });
  const root = document.body.appendChild(document.createElement("div"));
  onTestFinished(() => {
    act(() => render(null, root));
    root.remove();
    vi.unstubAllGlobals();
  });
  const workspace = {
    id: "alpha",
    name: "Compiler",
    rootUri: "file:///Compiler",
    scheme: "file",
    remote: false,
  };
  const controller = {
    state: { chats },
    workspaces: [workspace],
    changes: new Signal(),
  } as unknown as AgentController;
  const actions = {
    onCreateProject: vi.fn(async () => workspace),
    onOpenSessionInNewTab: vi.fn(),
    onDeleteSession: vi.fn(),
    onOpenSession: vi.fn(),
    onOpenAgent: vi.fn(),
    onNewSession: vi.fn(),
  };
  act(() => render(h(SidebarApp, { controller, ...actions }), root));
  const click = (selector: string) =>
    act(async () => {
      root.querySelector<HTMLButtonElement>(selector)!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  const project = ".as-create-project";
  await click(project);
  await click(project);
  expect(prompt).toHaveBeenCalledTimes(1);
  // Android Back releases the host's prompt entry without resolving the old promise.
  promptOpen = false;
  await click(project);
  await act(async () => submit(null));
  expect(actions.onCreateProject).not.toHaveBeenCalled();
  await click(project);
  let finishSession!: () => void;
  actions.onNewSession.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishSession = resolve;
      }),
  );
  await click('[aria-label="New session"]');
  await act(async () => submit("While busy"));
  expect(actions.onCreateProject).not.toHaveBeenCalled();
  await act(async () => finishSession());
  await click(project);
  await act(async () => submit("My notes"));
  await vi.waitFor(() =>
    expect(actions.onCreateProject).toHaveBeenCalledExactlyOnceWith("My notes"),
  );
  prompt.mockRejectedValueOnce(new Error("Prompt unavailable"));
  await click(project);
  await vi.waitFor(() => expect(toast).toHaveBeenCalledWith("Prompt unavailable"));
  await click('[aria-label="Open Fix parser in another tab"]');
  expect(actions.onOpenSessionInNewTab).toHaveBeenCalledExactlyOnceWith("older");
  await click('[aria-label="Delete Fix parser"]');
  await click('[aria-label="Delete Fix parser"]');
  expect(confirm).toHaveBeenCalledOnce();
  expect(actions.onDeleteSession).not.toHaveBeenCalled();
  await act(async () => answerDelete(false));
  expect(actions.onDeleteSession).not.toHaveBeenCalled();
  await vi.waitFor(() =>
    expect(
      root.querySelector<HTMLButtonElement>('[aria-label="Delete Fix parser"]')!.disabled,
    ).toBe(false),
  );
  await click('[aria-label="Delete Fix parser"]');
  expect(confirm).toHaveBeenCalledTimes(2);
  await act(async () => answerDelete(true));
  await vi.waitFor(() => expect(actions.onDeleteSession).toHaveBeenCalledExactlyOnceWith("older"));
});
