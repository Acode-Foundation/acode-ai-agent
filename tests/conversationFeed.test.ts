import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createRegistry, Harness, type EntryDraft } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { expect, test } from "vitest";
import { PortableCredentialStore } from "../src/platform/credentials";
import { ProviderRegistry } from "../src/providers/providerRegistry";
import { ConversationFeed } from "../src/session/conversationFeed";
import { appendHistory } from "../src/session/history";

/** `count` turns of one prompt and `answers` assistant messages each. */
function turns(from: number, count: number, answers = 0): EntryDraft[] {
  return Array.from({ length: count }, (_, index) => {
    const turn = from + index;
    return [
      {
        kind: "pi.user",
        model: [{ role: "user", content: `prompt ${turn}`, timestamp: turn }],
      },
      ...Array.from({ length: answers }, (_, step) => ({
        kind: "pi.assistant",
        model: [
          {
            role: "assistant",
            content: [{ type: "text", text: `answer ${turn}.${step}` }],
            api: "test",
            provider: "test",
            model: "test",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: turn,
          },
        ],
      })),
    ] as EntryDraft[];
  }).flat();
}

function texts(feed: ConversationFeed): string[] {
  return feed.value.entries.map((entry) => {
    const content = entry.model?.[0]?.content;
    if (typeof content === "string") return content;
    return (content?.[0] as { text?: string } | undefined)?.text ?? "";
  });
}

const prompts = (feed: ConversationFeed) => texts(feed).filter((text) => text.startsWith("prompt"));

async function openHarness() {
  const harness = await Harness.open(
    new MemoryStorage(),
    {
      models: new ProviderRegistry(new PortableCredentialStore(null)).harnessModels,
      registry: createRegistry(),
    },
    context,
  );
  return { harness, conversation: await harness.root(context) };
}

test("history all holds the whole transcript, beyond Pi's watch window", async () => {
  const { harness, conversation } = await openHarness();
  await appendHistory(harness, conversation.id, turns(0, 450), context);

  let changes = 0;
  const feed = await ConversationFeed.open(conversation, context, {
    history: "all",
    onChange: () => (changes += 1),
  });
  expect(texts(feed)).toHaveLength(450);
  expect(feed.value.hasEarlier).toBe(false);

  // More appends than the window's max keep every entry, in order.
  for (let batch = 0; batch < 3; batch += 1)
    await appendHistory(harness, conversation.id, turns(450 + batch * 250, 250), context);
  await expect.poll(() => texts(feed).length).toBe(1200);
  expect(texts(feed)).toEqual(Array.from({ length: 1200 }, (_, index) => `prompt ${index}`));
  expect(changes).toBeGreaterThan(0);

  feed.dispose();
  await harness.close(context);
});

test("history recent starts at a prompt and loads earlier turns on demand", async () => {
  const { harness, conversation } = await openHarness();
  // 300 turns of a prompt and two answers: 900 entries, the window holds 200.
  await appendHistory(harness, conversation.id, turns(0, 300, 2), context);

  const feed = await ConversationFeed.open(conversation, context, {
    history: "recent",
    onChange: () => undefined,
  });
  expect(feed.value.hasEarlier).toBe(true);
  expect(texts(feed)[0]).toMatch(/^prompt /);
  expect(texts(feed).at(-1)).toBe("answer 299.1");
  const first = prompts(feed).length;
  expect(first).toBeLessThan(300);

  await feed.loadEarlier(context);
  expect(prompts(feed).length).toBeGreaterThan(first);
  expect(texts(feed)[0]).toMatch(/^prompt /);

  while (feed.value.hasEarlier) await feed.loadEarlier(context);
  expect(prompts(feed)).toEqual(Array.from({ length: 300 }, (_, index) => `prompt ${index}`));
  expect(texts(feed)).toHaveLength(900);

  feed.dispose();
  await harness.close(context);
});

test("history recent loads back to a prompt when one turn outgrows the window", async () => {
  const { harness, conversation } = await openHarness();
  await appendHistory(harness, conversation.id, turns(0, 2, 300), context);

  const feed = await ConversationFeed.open(conversation, context, {
    history: "recent",
    onChange: () => undefined,
  });
  expect(texts(feed)[0]).toBe("prompt 1");
  expect(texts(feed)).toHaveLength(301);
  expect(feed.value.hasEarlier).toBe(true);

  feed.dispose();
  await harness.close(context);
});

test("history none starts at the window and keeps what follows", async () => {
  const { harness, conversation } = await openHarness();
  await appendHistory(harness, conversation.id, turns(0, 280), context);

  const feed = await ConversationFeed.open(conversation, context, {
    history: "none",
    onChange: () => undefined,
  });
  expect(texts(feed)).toHaveLength(200);
  expect(texts(feed)[0]).toBe("prompt 80");
  expect(feed.value.hasEarlier).toBe(false);

  await appendHistory(harness, conversation.id, turns(280, 500), context);
  await expect.poll(() => texts(feed).length).toBe(700);
  expect(texts(feed).at(-1)).toBe("prompt 779");

  feed.dispose();
  await harness.close(context);
});
