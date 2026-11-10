import type { Context } from "@earendil-works/chord/context";
import {
  ConversationTranscript,
  UserEntry,
  type Conversation,
  type ConversationWatch,
  type EntryRecord,
  type TranscriptView,
} from "@earendil-works/pi-durable";

/** Entries the first value holds, and each earlier page loads. */
const PAGE_SIZE = 200;

/** A conversation's documents and the entries the client shows, oldest first. */
export type FeedValue = {
  readonly docs: TranscriptView["docs"];
  readonly entries: readonly EntryRecord[];
  /** Older entries exist that are not loaded yet. */
  readonly hasEarlier: boolean;
};

/**
 * Which history a feed holds besides the live window: `all` loads the whole transcript up front,
 * `recent` starts at the newest prompts and loads older pages on `loadEarlier()`, `none` keeps only
 * what arrives after the watch starts.
 */
export type FeedHistory = "all" | "recent" | "none";

/**
 * A live conversation view over a whole transcript: Pi's watch holds only a window of the newest
 * entries, so each value is merged into a `ConversationTranscript`, gaps are filled, and earlier
 * pages are loaded as `history` asks.
 */
export class ConversationFeed {
  #watch: ConversationWatch;
  #transcript: ConversationTranscript;
  #history: FeedHistory;
  #view?: TranscriptView;
  #value: FeedValue;

  private constructor(
    watch: ConversationWatch,
    transcript: ConversationTranscript,
    history: FeedHistory,
  ) {
    this.#watch = watch;
    this.#transcript = transcript;
    this.#history = history;
    this.#value = { docs: watch.value.docs, entries: [], hasEarlier: false };
  }

  /** Watch `conversation`. `onChange` runs after every value once the feed is complete again. */
  static async open(
    conversation: Conversation,
    context: Context,
    options: { history: FeedHistory; onChange: () => void },
  ): Promise<ConversationFeed> {
    const transcript = new ConversationTranscript(
      (query, limit, ctx) => conversation.entries(query, limit, undefined, ctx),
      { pageSize: PAGE_SIZE },
    );
    const watch = await conversation.watch(context, { min: PAGE_SIZE });
    const feed = new ConversationFeed(watch, transcript, options.history);
    try {
      await feed.#apply(transcript.merge(watch.value), context);
    } catch (error) {
      void watch.stop();
      throw error;
    }
    watch.start(async (call, ctx) => {
      // A failed frame keeps the last value; the next value replaces it once Pi recovers.
      if (call.kind === "failed") return console.warn("Pi conversation watch", call.error);
      await feed.#apply(transcript.merge(call.value), ctx);
      options.onChange();
    });
    return feed;
  }

  get value(): FeedValue {
    return this.#value;
  }

  /** Load the page before the oldest prompt shown; resolves once the feed holds it. */
  async loadEarlier(context: Context): Promise<void> {
    if (!this.#value.hasEarlier) return;
    const shown = this.#value.entries.length;
    // Keep going until the page adds a whole prompt, not only the tail of one.
    let view = await this.#transcript.loadEarlier(context);
    this.#set(view);
    while (this.#value.entries.length === shown && hasEarlier(view)) {
      view = await this.#transcript.loadEarlier(context);
      this.#set(view);
    }
  }

  dispose(): void {
    void this.#watch.stop();
  }

  async #apply(view: TranscriptView, context: Context): Promise<void> {
    for (;;) {
      const gap = view.items.find((item) => item.kind === "gap");
      const earlier =
        hasEarlier(view) &&
        (this.#history === "all" || (this.#history === "recent" && !view.items.some(isUserItem)));
      const next = gap
        ? await this.#transcript.fillGap(gap, context)
        : earlier
          ? await this.#transcript.loadEarlier(context)
          : undefined;
      if (!next || next.items === view.items) break;
      view = next;
    }
    this.#set(view);
  }

  #set(view: TranscriptView): void {
    if (view.items === this.#view?.items) {
      if (view.docs !== this.#value.docs) this.#value = { ...this.#value, docs: view.docs };
      this.#view = view;
      return;
    }
    this.#view = view;
    let entries = view.items.flatMap((item) => (item.kind === "entry" ? [item.entry] : []));
    const earlier = this.#history !== "none" && hasEarlier(view);
    // A partial first turn would show answers without their prompt: start at the oldest prompt.
    if (earlier) {
      const first = entries.findIndex((entry) => UserEntry.is(entry));
      entries = first < 0 ? [] : entries.slice(first);
    }
    this.#value = { docs: view.docs, entries, hasEarlier: earlier };
  }
}

function hasEarlier(view: TranscriptView): boolean {
  return view.items[0]?.kind === "earlier";
}

function isUserItem(item: TranscriptView["items"][number]): boolean {
  return item.kind === "entry" && UserEntry.is(item.entry);
}
