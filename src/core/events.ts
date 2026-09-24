export type Unsubscribe = () => void;

export class Signal<T> {
  #listeners = new Set<(value: T) => void>();

  subscribe(listener: (value: T) => void): Unsubscribe {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(value: T): void {
    for (const listener of Array.from(this.#listeners)) listener(value);
  }

  clear(): void {
    this.#listeners.clear();
  }
}

/** Holds posted values until a receiver attaches, then delivers them in order. */
export class Mailbox<T> {
  #pending: T[] = [];
  #receiver?: (value: T) => void;

  post(value: T): void {
    if (this.#receiver) this.#receiver(value);
    else this.#pending.push(value);
  }

  receive(receiver: (value: T) => void): Unsubscribe {
    this.#receiver = receiver;
    for (const value of this.#pending.splice(0)) receiver(value);
    return () => {
      if (this.#receiver === receiver) this.#receiver = undefined;
    };
  }
}
