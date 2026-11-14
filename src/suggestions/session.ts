import { Signal } from "../core/events";
import { sponsorContext } from "./context";
import type { Sponsor } from "./elo";
import type { SponsorConsent } from "./preferences";

type SponsorTurn = {
  id: string;
  user?: string;
  answer?: string;
  error?: string;
  stopped?: boolean;
  streaming?: boolean;
};
export type SponsorPlacement = {
  chatId: string;
  turnId: string;
  sponsor: Sponsor;
};
type Dependencies = {
  eligible(): boolean;
  visible(): boolean;
  consent(): SponsorConsent;
  load(context: string[], signal: AbortSignal): Promise<Sponsor | null>;
  budget: SponsorBudget;
};
type SponsorHistory = readonly string[] | (() => readonly string[]);

export class SponsorBudget {
  optInChatId?: string;
  readonly changes = new Signal<void>();
  readonly released = new Signal<void>();
  readonly forgotten = new Signal<string>();
  #cards = new Map<string, { placement: SponsorPlacement; expiresAt: number }>();
  #seen = new Set<string>();
  #viewed = new WeakSet<SponsorPlacement>();
  #nextAdAt = -Infinity;
  #retryAfter = -Infinity;
  #pending = "";

  constructor(private now = () => Date.now()) {}

  card(chatId: string | undefined) {
    const cached = chatId ? this.#cards.get(chatId) : undefined;
    return cached && cached.expiresAt > this.now() ? cached.placement : undefined;
  }

  remaining(card: SponsorPlacement): number {
    return Math.max(0, (this.#cards.get(card.chatId)?.expiresAt ?? 0) - this.now());
  }

  /** Accept only the response for the active claim(`${chatId}:${turnId}`); stale responses are ignored. */
  add(card: SponsorPlacement) {
    // A late browser callback can dismiss another card while this request is in flight.
    // Deleting a chat also releases its request, so stale responses cannot restore it.
    if (this.#pending !== `${card.chatId}:${card.turnId}` || this.now() < this.#nextAdAt) return;
    this.#cards.set(card.chatId, {
      placement: card,
      expiresAt: this.now() + 300_000,
    });
    this.release(`${card.chatId}:${card.turnId}`);
    this.changes.emit();
  }

  dismiss(card: SponsorPlacement, suppress = false) {
    if (this.#cards.get(card.chatId)?.placement !== card) return;
    if (suppress) {
      this.#nextAdAt = this.now() + 300_000;
      this.clearCards();
      return;
    }
    this.#cards.delete(card.chatId);
    this.changes.emit();
  }

  expire() {
    let changed = false;
    for (const [key, cached] of this.#cards) {
      if (cached.expiresAt > this.now()) continue;
      this.#cards.delete(key);
      // A long wait may request a replacement after expiry and the view cooldown.
      this.#seen.delete(`${key}:${cached.placement.turnId}`);
      changed = true;
    }
    if (changed) this.changes.emit();
  }

  forgetChat(chatId: string) {
    this.forgotten.emit(chatId);
    if (this.#pending.startsWith(`${chatId}:`)) this.release(this.#pending);
    const offered = this.optInChatId === chatId;
    if (offered) this.optInChatId = undefined;
    const removed = this.#cards.delete(chatId);
    if (offered || removed) this.changes.emit();
  }

  clearCards() {
    if (!this.#cards.size) return;
    this.#cards.clear();
    this.changes.emit();
  }

  consentChanged(value: SponsorConsent) {
    if (value !== "allowed") this.clearCards();
  }

  skip(key: string) {
    this.#seen.add(key);
    if (this.#seen.size > 100) {
      const oldest = this.#seen.values().next();
      if (!oldest.done) this.#seen.delete(oldest.value);
    }
  }

  viewed(card: SponsorPlacement) {
    if (this.card(card.chatId) !== card || this.#viewed.has(card)) return;
    this.#viewed.add(card);
    this.#nextAdAt = this.now() + 300_000;
  }

  release(key: string) {
    if (this.#pending !== key) return;
    this.#pending = "";
    this.released.emit();
  }

  /** Reserve one request across tabs. Views and explicit dismissals share the five-minute cooldown. */
  claim(key: string): number | undefined {
    if (this.#seen.has(key) || this.#pending) return;
    const delay = Math.max(this.#nextAdAt, this.#retryAfter) - this.now();
    if (delay > 0) return delay;
    // Throttle every request, including success before its first measured impression.
    this.skip(key);
    this.#pending = key;
    this.#retryAfter = this.now() + 30_000;
    return 0;
  }
}

export class SponsorSession {
  #chatId?: string;
  #running = false;
  #liveTurn?: string;
  #turn?: SponsorTurn;
  #previousPrompts: SponsorHistory = [];
  #unsubscribe?: () => void;
  #waitTimer?: ReturnType<typeof setTimeout>;
  #request?: { turnId: string; controller: AbortController };

  constructor(private deps: Dependencies) {}

  update(
    chatId: string | undefined,
    running: boolean,
    turn?: SponsorTurn,
    previousPrompts: SponsorHistory = [],
  ): void {
    if (chatId !== this.#chatId) {
      this.dispose();
      this.#chatId = chatId;
    }
    if (!this.#unsubscribe) {
      let queued = false;
      const release = this.deps.budget.released.subscribe(() => {
        if (queued || !this.#running || !this.#turn?.streaming || this.#turn.answer) return;
        queued = true;
        // Finish the releasing session's state transition before waking other waits.
        queueMicrotask(() => {
          queued = false;
          if (this.#unsubscribe === unsubscribe) this.refresh();
        });
      });
      const forget = this.deps.budget.forgotten.subscribe((id) => {
        if (id === this.#chatId) this.dispose();
      });
      const unsubscribe = () => {
        release();
        forget();
      };
      this.#unsubscribe = unsubscribe;
    }
    // Restored history cannot initiate requests.
    if (running && turn?.streaming) this.#liveTurn = turn.id;
    this.#previousPrompts = previousPrompts;
    this.#running = running;
    this.#turn = turn;
    this.refresh();
  }

  refresh(): void {
    clearTimeout(this.#waitTimer);
    this.deps.budget.expire();
    if (!this.deps.eligible() || this.deps.consent() !== "allowed") {
      this.#cancelRequest();
      this.deps.budget.clearCards();
      return;
    }
    const chatId = this.#chatId;
    const turn = this.#turn;
    const waiting =
      this.#running && !!turn?.streaming && !turn.answer && !turn.stopped && !turn.error;
    if (turn?.stopped || turn?.error || this.#request?.turnId !== turn?.id) this.#cancelRequest();
    if (!this.deps.visible()) {
      this.#cancelRequest();
      return;
    }
    const cached = this.deps.budget.card(chatId);
    if (cached) {
      this.#waitTimer = setTimeout(() => this.refresh(), this.deps.budget.remaining(cached));
      return;
    }
    // A loaded or pending strip may stay after the reply; only waits start new requests.
    if (!waiting || !chatId || !turn?.user || turn.id !== this.#liveTurn || this.#request) return;
    const delay = this.deps.budget.claim(`${chatId}:${turn.id}`);
    if (delay === undefined) return;
    if (delay > 0) {
      clearTimeout(this.#waitTimer);
      this.#waitTimer = setTimeout(() => this.refresh(), delay);
      return;
    }
    const history =
      typeof this.#previousPrompts === "function" ? this.#previousPrompts() : this.#previousPrompts;
    void this.#load(chatId, turn.id, sponsorContext(turn.user, history));
  }

  dispose(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    clearTimeout(this.#waitTimer);
    this.#cancelRequest();
    this.#liveTurn = undefined;
    this.#turn = undefined;
    this.#previousPrompts = [];
  }

  #cancelRequest() {
    if (!this.#request) return;
    this.#request.controller.abort();
    this.deps.budget.release(`${this.#chatId}:${this.#request.turnId}`);
    this.#request = undefined;
  }

  async #load(chatId: string, turnId: string, topics: string[]) {
    const controller = new AbortController();
    this.#request = { turnId, controller };
    try {
      const sponsor = await this.deps.load(topics, controller.signal);
      if (
        sponsor &&
        !controller.signal.aborted &&
        this.#turn?.id === turnId &&
        !this.#turn.stopped &&
        !this.#turn.error &&
        this.deps.visible() &&
        this.deps.eligible() &&
        this.deps.consent() === "allowed"
      ) {
        this.deps.budget.add({ chatId, turnId, sponsor });
      }
    } catch {
      // Advertising never changes the chat's status or reports an error to the user.
    } finally {
      this.deps.budget.release(`${chatId}:${turnId}`);
      if (this.#request?.controller === controller) {
        this.#request = undefined;
        this.refresh();
      }
    }
  }
}
