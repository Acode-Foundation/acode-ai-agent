import type { Context } from "@earendil-works/chord/context";
import {
  ConversationTranscript,
  type Conversation,
  type ConversationWatch,
  type EntryRecord,
  type TranscriptView,
} from "@earendil-works/pi-durable";

const PAGE_SIZE = 500;

/** A conversation's documents and every entry the client holds, oldest first. */
export type FeedValue = {
  readonly docs: TranscriptView["docs"];
  readonly entries: readonly EntryRecord[];
};

/**
 * A live conversation view with its whole transcript: Pi's watch holds only a window of the newest
 * entries, so each value is merged into a `ConversationTranscript`, and earlier pages and gaps are
 * loaded until nothing is missing.
 */
export class ConversationFeed {
  #watch: ConversationWatch;
  #transcript: ConversationTranscript;
  #value: FeedValue;
  #items?: TranscriptView["items"];

  private constructor(watch: ConversationWatch, transcript: ConversationTranscript) {
    this.#watch = watch;
    this.#transcript = transcript;
    this.#value = { docs: watch.value.docs, entries: [] };
  }

  /**
   * Watch `conversation`; `history` loads the entries before the first window too. `onChange` runs
   * after every value once the transcript is complete again.
   */
  static async open(
    conversation: Conversation,
    context: Context,
    options: { history: boolean; onChange: () => void },
  ): Promise<ConversationFeed> {
    const transcript = new ConversationTranscript(
      (query, limit, ctx) => conversation.entries(query, limit, undefined, ctx),
      { pageSize: PAGE_SIZE },
    );
    const watch = await conversation.watch(context);
    const feed = new ConversationFeed(watch, transcript);
    try {
      await feed.#apply(transcript.merge(watch.value), options.history, context);
    } catch (error) {
      void watch.stop();
      throw error;
    }
    watch.start(async (call, ctx) => {
      // A failed frame keeps the last value; the next value replaces it once Pi recovers.
      if (call.kind === "failed") return console.warn("Pi conversation watch", call.error);
      await feed.#apply(transcript.merge(call.value), options.history, ctx);
      options.onChange();
    });
    return feed;
  }

  get value(): FeedValue {
    return this.#value;
  }

  dispose(): void {
    void this.#watch.stop();
  }

  async #apply(view: TranscriptView, earlier: boolean, context: Context): Promise<void> {
    for (;;) {
      const gap = view.items.find((item) => item.kind === "gap");
      const next = gap
        ? await this.#transcript.fillGap(gap, context)
        : earlier && view.items[0]?.kind === "earlier"
          ? await this.#transcript.loadEarlier(context)
          : undefined;
      if (!next || next.items === view.items) break;
      view = next;
    }
    if (view.items !== this.#items) {
      this.#items = view.items;
      this.#value = {
        docs: view.docs,
        entries: view.items.flatMap((item) => (item.kind === "entry" ? [item.entry] : [])),
      };
    } else if (view.docs !== this.#value.docs) {
      this.#value = { docs: view.docs, entries: this.#value.entries };
    }
  }
}
