import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createRegistry, Harness, type EntryDraft } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { expect, test } from "vitest";
import { PortableCredentialStore } from "../src/platform/credentials";
import { ProviderRegistry } from "../src/providers/providerRegistry";
import { ConversationFeed } from "../src/session/conversationFeed";
import { appendHistory } from "../src/session/history";

function userEntries(from: number, count: number): EntryDraft[] {
  return Array.from({ length: count }, (_, index) => ({
    kind: "pi.user",
    model: [{ role: "user", content: `message ${from + index}`, timestamp: from + index }],
  }));
}

function texts(feed: ConversationFeed): string[] {
  return feed.value.entries.map((entry) => String(entry.model?.[0]?.content));
}

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

test("a feed holds the whole transcript, beyond Pi's watch window", async () => {
  const { harness, conversation } = await openHarness();
  await appendHistory(harness, conversation.id, userEntries(0, 180), context);

  let changes = 0;
  const feed = await ConversationFeed.open(conversation, context, {
    history: true,
    onChange: () => (changes += 1),
  });
  expect(texts(feed)).toHaveLength(180);
  expect(texts(feed)[0]).toBe("message 0");

  // More appends than the window's max keep every entry, in order.
  for (let batch = 0; batch < 3; batch += 1)
    await appendHistory(harness, conversation.id, userEntries(180 + batch * 60, 60), context);
  await expect.poll(() => texts(feed).length).toBe(360);
  expect(texts(feed)).toEqual(Array.from({ length: 360 }, (_, index) => `message ${index}`));
  expect(changes).toBeGreaterThan(0);

  feed.dispose();
  await harness.close(context);
});

test("a feed without history starts at the window and keeps what follows", async () => {
  const { harness, conversation } = await openHarness();
  await appendHistory(harness, conversation.id, userEntries(0, 80), context);

  const feed = await ConversationFeed.open(conversation, context, {
    history: false,
    onChange: () => undefined,
  });
  expect(texts(feed)).toHaveLength(50);
  expect(texts(feed)[0]).toBe("message 30");

  await appendHistory(harness, conversation.id, userEntries(80, 120), context);
  await expect.poll(() => texts(feed).length).toBe(170);
  expect(texts(feed).at(-1)).toBe("message 199");

  feed.dispose();
  await harness.close(context);
});
