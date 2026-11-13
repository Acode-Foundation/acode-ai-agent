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
export type SponsorPlacement = { turnId: string; context: string[]; sponsor?: Sponsor };
type Dependencies = {
  eligible(): boolean;
  visible(): boolean;
  consent(): SponsorConsent;
  load(context: string[], signal: AbortSignal, waiting: boolean): Promise<Sponsor | null>;
  budget: SponsorBudget;
};

export class SponsorBudget {
  #seen = new Set<string>();
  #turns = 0;
  #lastAttempt = -Infinity;

  constructor(private now = () => Date.now()) {}

  claim(key: string, waiting = false): boolean {
    if (this.#seen.has(key)) return false;
    const due = this.#turns >= 2 && this.now() - this.#lastAttempt >= 5 * 60_000;
    // A wait that cannot show an ad must still count normally once it succeeds.
    if (waiting && !due) return false;
    this.#seen.add(key);
    if (this.#seen.size > 100) {
      const oldest = this.#seen.values().next();
      if (!oldest.done) this.#seen.delete(oldest.value);
    }
    if (!due) {
      this.#turns++;
      return false;
    }
    this.#turns = 0;
    this.#lastAttempt = this.now();
    return true;
  }
}

export class SponsorSession {
  readonly changes = new Signal<SponsorPlacement | undefined>();
  placement?: SponsorPlacement;
  #chatId?: string;
  #running = false;
  #runningTurn?: string;
  #request?: AbortController;
  #waitingTurn?: string;

  constructor(private deps: Dependencies) {}

  update(chatId: string | undefined, running: boolean, turn?: SponsorTurn): void {
    this.#runningTurn =
      running && turn?.streaming && !turn.answer && !turn.stopped && !turn.error
        ? turn.id
        : undefined;
    if (this.#chatId !== chatId) {
      this.clear();
      this.#chatId = chatId;
      this.#running = running;
      return;
    }
    const finished = this.#running && !running;
    this.#running = running;
    if (!this.deps.eligible() || this.deps.consent() === "declined") {
      this.clear();
      return;
    }
    if (this.#waitingTurn) {
      if (
        turn?.id === this.#waitingTurn &&
        !turn.error &&
        !turn.stopped &&
        (running || turn.answer)
      ) {
        if (!running) this.#waitingTurn = undefined;
        return;
      }
      this.clear();
    }
    if (running) {
      this.clear();
      return;
    }
    if (
      !finished ||
      !this.deps.visible() ||
      !chatId ||
      !turn?.answer ||
      !turn.user ||
      turn.error ||
      turn.stopped ||
      turn.streaming
    )
      return;
    if (!this.deps.budget.claim(`${chatId}:${turn.id}`)) return;
    const placement = { turnId: turn.id, context: sponsorContext(turn.user) };
    if (this.deps.consent() === "ask") this.#publish(placement);
    else void this.#load(placement);
  }

  showWhileWaiting(chatId: string, turnId: string, prompt: string): void {
    if (
      this.#runningTurn !== turnId ||
      this.#chatId !== chatId ||
      !this.deps.visible() ||
      !this.deps.eligible() ||
      this.deps.consent() !== "allowed"
    )
      return;
    if (!this.deps.budget.claim(`${chatId}:${turnId}`, true)) return;
    void this.#load({ turnId, context: sponsorContext(prompt) }, true);
  }

  refresh(): void {
    if (!this.deps.eligible() || this.deps.consent() === "declined") this.clear();
    else if (!this.deps.visible()) this.#request?.abort();
    else if (this.placement && !this.placement.sponsor && this.deps.consent() === "allowed")
      this.allow();
  }

  allow(): void {
    if (this.placement && !this.placement.sponsor) void this.#load(this.placement);
  }

  clear(): void {
    this.#waitingTurn = undefined;
    this.#request?.abort();
    this.#request = undefined;
    if (this.placement) this.#publish(undefined);
  }

  dispose(): void {
    this.#runningTurn = undefined;
    this.clear();
    this.changes.clear();
  }

  async #load(placement: SponsorPlacement, waiting = false): Promise<void> {
    this.clear();
    if (!this.deps.visible() || !this.deps.eligible() || this.deps.consent() !== "allowed") return;
    if (waiting) this.#waitingTurn = placement.turnId;
    const request = new AbortController();
    this.#request = request;
    try {
      const sponsor = await this.deps.load(placement.context, request.signal, waiting);
      if (
        request.signal.aborted ||
        !this.deps.visible() ||
        !this.deps.eligible() ||
        this.deps.consent() !== "allowed"
      )
        return;
      if (sponsor) this.#publish({ ...placement, sponsor });
    } catch {
      // Advertising never changes the chat's status or reports an error to the user.
    } finally {
      if (this.#request === request) this.#request = undefined;
    }
  }

  #publish(placement: SponsorPlacement | undefined): void {
    this.placement = placement;
    this.changes.emit(placement);
  }
}
