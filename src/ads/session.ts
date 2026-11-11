import { Signal } from "../core/events";
import { sponsorContext } from "./context";
import type { Sponsor } from "./elo";
import type { SponsorConsent } from "./preferences";

type CompletedTurn = {
  id: string;
  user?: string;
  answer?: string;
  error?: string;
  stopped?: boolean;
  streaming?: boolean;
};
export type SponsorPlacement = { turnId: string; context: string; sponsor?: Sponsor };
type Dependencies = {
  eligible(): boolean;
  visible(): boolean;
  consent(): SponsorConsent;
  load(context: string, signal: AbortSignal): Promise<Sponsor | null>;
  budget: SponsorBudget;
};

export class SponsorBudget {
  #seen = new Set<string>();
  #turns = 0;
  #lastAttempt = -Infinity;

  constructor(private now = Date.now) {}

  claim(key: string): boolean {
    if (this.#seen.has(key)) return false;
    this.#seen.add(key);
    if (this.#seen.size > 100) this.#seen.delete(this.#seen.values().next().value!);
    this.#turns++;
    if (this.#turns < 3 || this.now() - this.#lastAttempt < 5 * 60_000) return false;
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
  #request?: AbortController;

  constructor(private deps: Dependencies) {}

  update(chatId: string | undefined, running: boolean, turn?: CompletedTurn): void {
    if (this.#chatId !== chatId) {
      this.clear();
      this.#chatId = chatId;
      this.#running = running;
      return;
    }
    const finished = this.#running && !running;
    this.#running = running;
    if (running || !this.deps.eligible() || this.deps.consent() === "declined") {
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

  refresh(): void {
    if (!this.deps.eligible() || this.deps.consent() === "declined") this.clear();
    else if (
      this.placement &&
      !this.placement.sponsor &&
      this.deps.visible() &&
      this.deps.consent() === "allowed"
    )
      this.allow();
  }

  allow(): void {
    if (this.placement && !this.placement.sponsor) void this.#load(this.placement);
  }

  clear(): void {
    this.#request?.abort();
    this.#request = undefined;
    if (this.placement) this.#publish(undefined);
  }

  dispose(): void {
    this.clear();
    this.changes.clear();
  }

  async #load(placement: SponsorPlacement): Promise<void> {
    this.clear();
    if (!this.deps.eligible() || this.deps.consent() !== "allowed") return;
    const request = new AbortController();
    this.#request = request;
    try {
      const sponsor = await this.deps.load(placement.context, request.signal);
      if (request.signal.aborted || !this.deps.eligible() || this.deps.consent() !== "allowed")
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
