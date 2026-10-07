/**
 * Small runtime polyfills for older Android System WebViews. Pi's durable harness and
 * Chord use a few APIs newer than the bundle's Chrome 90 syntax target; esbuild lowers
 * syntax but does not add missing built-ins.
 */
type Resolvers<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

const promise = Promise as PromiseConstructor & { withResolvers?: <T>() => Resolvers<T> };
promise.withResolvers ??= <T>(): Resolvers<T> => {
  let resolve!: Resolvers<T>["resolve"];
  let reject!: Resolvers<T>["reject"];
  const created = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise: created, resolve, reject };
};

const objectConstructor = Object as ObjectConstructor & {
  hasOwn?: (target: object, key: PropertyKey) => boolean;
};
objectConstructor.hasOwn ??= (target, key) => Object.prototype.hasOwnProperty.call(target, key);

type FindLast = {
  findLast?: (predicate: (value: unknown, index: number, array: unknown[]) => unknown) => unknown;
  findLastIndex?: (
    predicate: (value: unknown, index: number, array: unknown[]) => unknown,
  ) => number;
};
const arrayPrototype = Array.prototype as unknown as FindLast;
if (!arrayPrototype.findLastIndex) {
  Object.defineProperty(Array.prototype, "findLastIndex", {
    configurable: true,
    writable: true,
    value(
      this: unknown[],
      predicate: (value: unknown, index: number, array: unknown[]) => unknown,
    ) {
      for (let index = this.length - 1; index >= 0; index -= 1)
        if (predicate(this[index], index, this)) return index;
      return -1;
    },
  });
}
if (!arrayPrototype.findLast) {
  Object.defineProperty(Array.prototype, "findLast", {
    configurable: true,
    writable: true,
    value(
      this: unknown[],
      predicate: (value: unknown, index: number, array: unknown[]) => unknown,
    ) {
      for (let index = this.length - 1; index >= 0; index -= 1)
        if (predicate(this[index], index, this)) return this[index];
      return undefined;
    },
  });
}

const abortSignal = AbortSignal as typeof AbortSignal & {
  any?: (signals: AbortSignal[]) => AbortSignal;
};
abortSignal.any ??= (signals: AbortSignal[]): AbortSignal => {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
  }
  for (const signal of signals)
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  return controller.signal;
};

export {};
