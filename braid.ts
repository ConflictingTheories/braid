/**
 * ============================================================
 *  🧶 BRAID — A Language-Agnostic Co-routine Framework
 * ============================================================
 *
 * Core metaphor: You are weaving independent asynchronous
 * "strands" into a single synchronized cord. The resulting
 * Braid can itself become a strand in another Braid, enabling
 * arbitrarily deep composition.
 *
 * Design principles
 * ─────────────────
 * 1. Single-file, zero-dependency implementation.
 * 2. Every concept maps 1-to-1 to the language-agnostic spec
 *    so the same model ports cleanly to Python, Go, Rust, etc.
 * 3. The public surface is intentionally small: Fiber, Braid,
 *    Tension, Loom, and a handful of combinators.
 */

// ─────────────────────────────────────────────────────────────
//  § 1  PRIMITIVE TYPES
// ─────────────────────────────────────────────────────────────

/** The raw yielded type from a single Fiber. */
export type Strand<T> = AsyncGenerator<T, void, undefined>;

/** A snapshot tuple — one value per fiber in the Braid. */
export type Tuple<T extends unknown[]> = { [K in keyof T]: T[K] };

// ─────────────────────────────────────────────────────────────
//  § 2  TENSION  (scheduling policy)
// ─────────────────────────────────────────────────────────────

export enum Tension {
  /**
   * TIGHT (default) — Atomic lock-step.
   * The Braid advances only when *all* strands have yielded a
   * new value in the current round.
   */
  Tight = "Tight",

  /**
   * LOOSE — Fluid / non-blocking.
   * Fast strands use the *last known* value of slow strands.
   * The Braid emits every time *any* strand produces a value.
   */
  Loose = "Loose",

  /**
   * FRAYED — Strict fault intolerance.
   * If *any* strand throws or exhausts before the others, the
   * entire Braid immediately throws (or stops, respectively).
   */
  Frayed = "Frayed",
}

// ─────────────────────────────────────────────────────────────
//  § 3  FIBER  (single strand wrapper)
// ─────────────────────────────────────────────────────────────

export interface FiberOptions {
  /** Human-readable label for debugging / tracing. */
  name?: string;
}

/**
 * A Fiber wraps any `AsyncGenerator` (or factory thereof)
 * and gives it an identity.  It is the atom of the Braid.
 */
export class Fiber<T> {
  readonly name: string;
  private readonly factory: () => Strand<T>;

  constructor(
    gen: (() => Strand<T>) | Strand<T>,
    options: FiberOptions = {}
  ) {
    // Accept either a generator instance or a factory function.
    // Factory functions are preferred because they allow the
    // Fiber to be restarted / replayed.
    this.factory =
      typeof gen === "function"
        ? (gen as () => Strand<T>)
        : () => gen as Strand<T>;

    this.name = options.name ?? `fiber-${Math.random().toString(36).slice(2, 7)}`;
  }

  /** Materialise a fresh generator instance. */
  spawn(): Strand<T> {
    return this.factory();
  }

  // ── Combinator: map ─────────────────────────────────────────
  /** Return a new Fiber whose values are transformed by `fn`. */
  map<U>(fn: (value: T) => U): Fiber<U> {
    const self = this;
    return new Fiber<U>(
      async function* () {
        for await (const value of self.spawn()) {
          yield fn(value);
        }
      },
      { name: `${self.name}:map` }
    );
  }

  // ── Combinator: filter ───────────────────────────────────────
  /** Return a new Fiber that only forwards values satisfying `pred`. */
  filter(pred: (value: T) => boolean): Fiber<T> {
    const self = this;
    return new Fiber<T>(
      async function* () {
        for await (const value of self.spawn()) {
          if (pred(value)) yield value;
        }
      },
      { name: `${self.name}:filter` }
    );
  }

  // ── Combinator: take ─────────────────────────────────────────
  /** Return a new Fiber that stops after `n` values. */
  take(n: number): Fiber<T> {
    const self = this;
    return new Fiber<T>(
      async function* () {
        let count = 0;
        for await (const value of self.spawn()) {
          yield value;
          if (++count >= n) return;
        }
      },
      { name: `${self.name}:take(${n})` }
    );
  }

  // ── Combinator: prepend ───────────────────────────────────────
  /** Emit a seed value before the generator starts. */
  prepend(seed: T): Fiber<T> {
    const self = this;
    return new Fiber<T>(
      async function* () {
        yield seed;
        yield* self.spawn();
      },
      { name: `${self.name}:prepend` }
    );
  }
}

// ─────────────────────────────────────────────────────────────
//  § 4  BRAID  (woven collection of Fibers)
// ─────────────────────────────────────────────────────────────

export interface BraidOptions {
  tension?: Tension;
  /** Timeout (ms) per round for FRAYED tension.  Default: none. */
  timeout?: number;
}

/**
 * Internal bookkeeping per strand.
 */
interface StrandState<T> {
  fiber: Fiber<T>;
  gen: Strand<T>;
  lastValue: T | undefined;
  done: boolean;
  pending: Promise<IteratorResult<T>> | null;
}

/**
 * A Braid weaves N Fibers together.
 *
 * The generic parameter `Ts` is a tuple type mirroring the
 * fiber types so the output tuple is fully typed.
 *
 * Example:
 *   const b = new Braid([fiberA, fiberB])  // Braid<[A, B]>
 */
export class Braid<Ts extends unknown[]> {
  private states: StrandState<unknown>[] = [];
  private options: Required<BraidOptions>;
  private _running = false;

  constructor(
    fibers: { [K in keyof Ts]: Fiber<Ts[K]> },
    options: BraidOptions = {}
  ) {
    this.options = {
      tension: options.tension ?? Tension.Tight,
      timeout: options.timeout ?? 0,
    };

    for (const fiber of fibers as Fiber<unknown>[]) {
      this.states.push({
        fiber,
        gen: fiber.spawn(),
        lastValue: undefined,
        done: false,
        pending: null,
      });
    }
  }

  // ── Dynamic plaiting ─────────────────────────────────────────

  /**
   * Add a new Fiber to a *running* Braid.
   * In TIGHT tension, the next round will wait for this strand too.
   * In LOOSE tension, it participates immediately with `undefined`
   * until its first yield.
   */
  plait<U>(fiber: Fiber<U>): Braid<[...Ts, U]> {
    (this.states as StrandState<unknown>[]).push({
      fiber: fiber as Fiber<unknown>,
      gen: fiber.spawn(),
      lastValue: undefined,
      done: false,
      pending: null,
    });
    return this as unknown as Braid<[...Ts, U]>;
  }

  /**
   * Stop the Braid and return the last-known value of each strand.
   */
  fray(): Partial<Ts> {
    this._running = false;
    return this.states.map((s) => s.lastValue) as unknown as Partial<Ts>;
  }

  /**
   * Pipe the synchronized tuple through a transformation function,
   * returning a *new* Fiber whose values are the transformed results.
   * This is the "Bind" operation — it lets a Braid feed into
   * downstream processing.
   */
  bind<U>(fn: (tuple: Ts) => U): Fiber<U> {
    const self = this;
    return new Fiber<U>(async function* () {
      for await (const tuple of self) {
        yield fn(tuple);
      }
    });
  }

  // ── AsyncIterator implementation ─────────────────────────────

  /**
   * The Braid is itself an AsyncGenerator, meaning it can be used
   * directly in `for await` loops, passed to `Loom.run()`, or
   * wrapped in another Fiber.
   */
  async *[Symbol.asyncIterator](): AsyncGenerator<Ts, void, undefined> {
    this._running = true;

    switch (this.options.tension) {
      case Tension.Tight:
        yield* this._tightWeave();
        break;
      case Tension.Loose:
        yield* this._looseWeave();
        break;
      case Tension.Frayed:
        yield* this._frayedWeave();
        break;
    }

    this._running = false;
  }

  // ── Private weave strategies ──────────────────────────────────

  /**
   * TIGHT: advance all strands in parallel, emit only when all
   * have produced a new value in this round.
   */
  private async *_tightWeave(): AsyncGenerator<Ts> {
    while (this._running) {
      // Kick off all pending advances in parallel
      const results = await Promise.all(
        this.states.map((s) => (s.done ? Promise.resolve(null) : s.gen.next()))
      );

      let anyDone = false;
      for (let i = 0; i < this.states.length; i++) {
        const r = results[i];
        if (r === null) continue;
        if (r.done) {
          this.states[i].done = true;
          anyDone = true;
        } else {
          this.states[i].lastValue = r.value;
        }
      }

      if (anyDone) return;

      yield this.states.map((s) => s.lastValue) as unknown as Ts;
    }
  }

  /**
   * LOOSE: each strand races independently. The Braid emits
   * whenever *any* strand produces a new value, using the
   * cached last value for all other strands.
   */
  private async *_looseWeave(): AsyncGenerator<Ts> {
    // Seed all strands to get their first value
    const bootstraps = await Promise.all(
      this.states.map((s) => s.gen.next())
    );
    for (let i = 0; i < this.states.length; i++) {
      const r = bootstraps[i];
      if (!r.done) this.states[i].lastValue = r.value;
      else this.states[i].done = true;
    }

    // Emit initial snapshot
    if (this.states.every((s) => s.lastValue !== undefined || s.done)) {
      yield this.states.map((s) => s.lastValue) as unknown as Ts;
    }

    // Maintain a racing set
    const makeRace = (s: StrandState<unknown>, idx: number) =>
      s.gen.next().then((r) => ({ r, idx }));

    const pending = new Map<number, Promise<{ r: IteratorResult<unknown>; idx: number }>>();
    for (let i = 0; i < this.states.length; i++) {
      if (!this.states[i].done) {
        pending.set(i, makeRace(this.states[i], i));
      }
    }

    while (this._running && pending.size > 0) {
      const { r, idx } = await Promise.race(pending.values());
      pending.delete(idx);

      if (r.done) {
        this.states[idx].done = true;
      } else {
        this.states[idx].lastValue = r.value;
        pending.set(idx, makeRace(this.states[idx], idx));
        yield this.states.map((s) => s.lastValue) as unknown as Ts;
      }
    }
  }

  /**
   * FRAYED: like TIGHT but any error or early completion from
   * *any* strand causes the entire Braid to throw/stop.
   */
  private async *_frayedWeave(): AsyncGenerator<Ts> {
    while (this._running) {
      const advancing = this.states.map((s, idx) => {
        const base = s.gen.next().then((r) => ({ r, idx }));
        if (this.options.timeout > 0) {
          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new BraidTimeoutError(`Strand ${s.fiber.name} timed out`)),
              this.options.timeout
            )
          );
          return Promise.race([base, timeoutPromise]);
        }
        return base;
      });

      const results = await Promise.all(advancing);

      for (const { r, idx } of results) {
        if (r.done) {
          // Any strand exhausting causes orderly stop
          return;
        }
        this.states[idx].lastValue = r.value;
      }

      yield this.states.map((s) => s.lastValue) as unknown as Ts;
    }
  }
}

// ─────────────────────────────────────────────────────────────
//  § 5  LOOM  (executor)
// ─────────────────────────────────────────────────────────────

export interface LoomOptions {
  /** Maximum number of tuples to process before stopping. */
  limit?: number;
  /** Called when the Braid completes normally. */
  onComplete?: () => void;
  /** Called if the Braid throws. */
  onError?: (err: unknown) => void;
}

/**
 * The Loom is the executor that runs a Braid (or any
 * AsyncIterable) to completion, calling `handler` for
 * each emitted value.
 *
 * It returns a Promise that resolves when done.
 */
export class Loom {
  /**
   * Run a Braid or any Fiber to completion.
   *
   * @param source  Braid, Fiber, or any AsyncIterable<T>
   * @param handler Called for each emitted value
   * @param options Optional limits / callbacks
   */
  static async run<T>(
    source: AsyncIterable<T>,
    handler: (value: T, index: number) => void | Promise<void>,
    options: LoomOptions = {}
  ): Promise<void> {
    const { limit = Infinity, onComplete, onError } = options;
    let index = 0;

    try {
      for await (const value of source) {
        await handler(value, index);
        if (++index >= limit) break;
      }
      onComplete?.();
    } catch (err) {
      if (onError) {
        onError(err);
      } else {
        throw err;
      }
    }
  }

  /**
   * Collect all emitted values into an array.
   * Useful for finite Braids / testing.
   */
  static async collect<T>(
    source: AsyncIterable<T>,
    options: LoomOptions = {}
  ): Promise<T[]> {
    const results: T[] = [];
    await Loom.run(source, (v) => { results.push(v); }, options);
    return results;
  }

  /**
   * Run multiple Braids concurrently, each with its own handler.
   * Returns when *all* complete.
   */
  static async runAll<T>(
    pairs: Array<[AsyncIterable<T>, (value: T, index: number) => void]>,
    options: LoomOptions = {}
  ): Promise<void> {
    await Promise.all(pairs.map(([source, handler]) => Loom.run(source, handler, options)));
  }
}

// ─────────────────────────────────────────────────────────────
//  § 6  COMBINATORS  (higher-level weaving utilities)
// ─────────────────────────────────────────────────────────────

/**
 * Interleave values from two Braids/Fibers sequentially
 * (first drain A, then drain B).
 */
export async function* chain<T>(
  ...sources: AsyncIterable<T>[]
): AsyncGenerator<T> {
  for (const src of sources) {
    yield* src;
  }
}

/**
 * Merge N Fibers into one, emitting values as they arrive
 * (true fan-in, order not guaranteed).
 */
export function merge<T>(...fibers: Fiber<T>[]): Fiber<T> {
  return new Fiber<T>(
    async function* () {
      const gens = fibers.map((f) => f.spawn());
      type RaceResult = { value: T; done: boolean; idx: number };

      const advance = (gen: Strand<T>, idx: number): Promise<RaceResult> =>
        gen.next().then((r) => ({ value: r.value as T, done: !!r.done, idx }));

      const pending = new Map(gens.map((g, i) => [i, advance(g, i)]));

      while (pending.size > 0) {
        const { value, done, idx } = await Promise.race(pending.values());
        pending.delete(idx);
        if (!done) {
          yield value;
          pending.set(idx, advance(gens[idx], idx));
        }
      }
    },
    { name: "merge" }
  );
}

/**
 * Zip two Fibers into a Fiber of pairs.
 * Alias for `new Braid([a, b]).bind(t => t)` but more ergonomic
 * for binary cases.
 */
export function zip<A, B>(a: Fiber<A>, b: Fiber<B>): Fiber<[A, B]> {
  return new Braid<[A, B]>([a, b]).bind((t) => t);
}

/**
 * Partition a Fiber into two Fibers using a predicate.
 * Note: both returned Fibers share the same underlying generator;
 * they must be consumed concurrently (e.g., inside a Braid).
 */
export function partition<T>(
  fiber: Fiber<T>,
  pred: (v: T) => boolean
): [Fiber<T>, Fiber<T>] {
  const trueQueue: T[] = [];
  const falseQueue: T[] = [];
  const resolvers: Array<() => void> = [];

  let sourceDone = false;

  async function pump() {
    for await (const v of fiber.spawn()) {
      if (pred(v)) trueQueue.push(v);
      else falseQueue.push(v);
      resolvers.forEach((r) => r());
      resolvers.length = 0;
    }
    sourceDone = true;
    resolvers.forEach((r) => r());
  }

  pump();

  const makeReader = (queue: T[]): Fiber<T> =>
    new Fiber<T>(async function* () {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift()!;
        } else if (sourceDone) {
          return;
        } else {
          await new Promise<void>((res) => resolvers.push(res));
        }
      }
    });

  return [makeReader(trueQueue), makeReader(falseQueue)];
}

// ─────────────────────────────────────────────────────────────
//  § 7  ERRORS
// ─────────────────────────────────────────────────────────────

export class BraidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BraidError";
  }
}

export class BraidTimeoutError extends BraidError {
  constructor(message: string) {
    super(message);
    this.name = "BraidTimeoutError";
  }
}

// ─────────────────────────────────────────────────────────────
//  § 8  CONVENIENCE FACTORIES
// ─────────────────────────────────────────────────────────────

/** Create a Fiber from a static array (finite). */
export function fromArray<T>(values: T[], name?: string): Fiber<T> {
  return new Fiber<T>(
    async function* () {
      for (const v of values) yield v;
    },
    { name: name ?? "fromArray" }
  );
}

/** Create an infinite counting Fiber with optional interval (ms). */
export function counter(
  start = 0,
  intervalMs = 0,
  name?: string
): Fiber<number> {
  return new Fiber<number>(
    async function* () {
      let n = start;
      while (true) {
        yield n++;
        if (intervalMs > 0)
          await new Promise((r) => setTimeout(r, intervalMs));
      }
    },
    { name: name ?? "counter" }
  );
}

/** Create a Fiber that emits a value every `intervalMs` ms. */
export function interval<T>(
  value: T | (() => T),
  intervalMs: number,
  name?: string
): Fiber<T> {
  return new Fiber<T>(
    async function* () {
      while (true) {
        await new Promise((r) => setTimeout(r, intervalMs));
        yield typeof value === "function" ? (value as () => T)() : value;
      }
    },
    { name: name ?? "interval" }
  );
}

/** Create a Fiber that emits a single value and completes. */
export function just<T>(value: T, name?: string): Fiber<T> {
  return new Fiber<T>(
    async function* () {
      yield value;
    },
    { name: name ?? "just" }
  );
}
