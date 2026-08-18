export type Unsubscribe = () => void;

export class Signal<T> {
	#listeners = new Set<(value: T) => void>();

	subscribe(listener: (value: T) => void): Unsubscribe {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	emit(value: T): void {
		for (const listener of [...this.#listeners]) listener(value);
	}

	clear(): void {
		this.#listeners.clear();
	}
}

