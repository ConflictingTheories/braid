"use strict";
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
var Tension = /* @__PURE__ */ ((Tension2) => {
  Tension2["Tight"] = "Tight";
  Tension2["Loose"] = "Loose";
  Tension2["Frayed"] = "Frayed";
  return Tension2;
})(Tension || {});
class Fiber {
  constructor(gen, options = {}) {
    this.factory = typeof gen === "function" ? gen : () => gen;
    this.name = options.name ?? `fiber-${Math.random().toString(36).slice(2, 7)}`;
  }
  /** Materialise a fresh generator instance. */
  spawn() {
    return this.factory();
  }
  // ── Combinator: map ─────────────────────────────────────────
  /** Return a new Fiber whose values are transformed by `fn`. */
  map(fn) {
    const self = this;
    return new Fiber(
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
  filter(pred) {
    const self = this;
    return new Fiber(
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
  take(n) {
    const self = this;
    return new Fiber(
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
  prepend(seed) {
    const self = this;
    return new Fiber(
      async function* () {
        yield seed;
        yield* self.spawn();
      },
      { name: `${self.name}:prepend` }
    );
  }
}
class Braid {
  constructor(fibers, options = {}) {
    this.states = [];
    this._running = false;
    this.options = {
      tension: options.tension ?? "Tight",
      timeout: options.timeout ?? 0
    };
    for (const fiber of fibers) {
      this.states.push({
        fiber,
        gen: fiber.spawn(),
        lastValue: void 0,
        done: false,
        pending: null
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
  plait(fiber) {
    this.states.push({
      fiber,
      gen: fiber.spawn(),
      lastValue: void 0,
      done: false,
      pending: null
    });
    return this;
  }
  /**
   * Stop the Braid and return the last-known value of each strand.
   */
  fray() {
    this._running = false;
    return this.states.map((s) => s.lastValue);
  }
  /**
   * Pipe the synchronized tuple through a transformation function,
   * returning a *new* Fiber whose values are the transformed results.
   * This is the "Bind" operation — it lets a Braid feed into
   * downstream processing.
   */
  bind(fn) {
    const self = this;
    return new Fiber(async function* () {
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
  async *[Symbol.asyncIterator]() {
    this._running = true;
    switch (this.options.tension) {
      case "Tight":
        yield* this._tightWeave();
        break;
      case "Loose":
        yield* this._looseWeave();
        break;
      case "Frayed":
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
  async *_tightWeave() {
    while (this._running) {
      const results = await Promise.all(
        this.states.map((s) => s.done ? Promise.resolve(null) : s.gen.next())
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
      yield this.states.map((s) => s.lastValue);
    }
  }
  /**
   * LOOSE: each strand races independently. The Braid emits
   * whenever *any* strand produces a new value, using the
   * cached last value for all other strands.
   */
  async *_looseWeave() {
    const bootstraps = await Promise.all(
      this.states.map((s) => s.gen.next())
    );
    for (let i = 0; i < this.states.length; i++) {
      const r = bootstraps[i];
      if (!r.done) this.states[i].lastValue = r.value;
      else this.states[i].done = true;
    }
    if (this.states.every((s) => s.lastValue !== void 0 || s.done)) {
      yield this.states.map((s) => s.lastValue);
    }
    const makeRace = (s, idx) => s.gen.next().then((r) => ({ r, idx }));
    const pending = /* @__PURE__ */ new Map();
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
        yield this.states.map((s) => s.lastValue);
      }
    }
  }
  /**
   * FRAYED: like TIGHT but any error or early completion from
   * *any* strand causes the entire Braid to throw/stop.
   */
  async *_frayedWeave() {
    while (this._running) {
      const advancing = this.states.map((s, idx) => {
        const base = s.gen.next().then((r) => ({ r, idx }));
        if (this.options.timeout > 0) {
          const timeoutPromise = new Promise(
            (_, reject) => setTimeout(
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
          return;
        }
        this.states[idx].lastValue = r.value;
      }
      yield this.states.map((s) => s.lastValue);
    }
  }
}
class Loom {
  /**
   * Run a Braid or any Fiber to completion.
   *
   * @param source  Braid, Fiber, or any AsyncIterable<T>
   * @param handler Called for each emitted value
   * @param options Optional limits / callbacks
   */
  static async run(source, handler, options = {}) {
    const { limit = Infinity, onComplete, onError } = options;
    let index = 0;
    try {
      for await (const value of source) {
        await handler(value, index);
        if (++index >= limit) break;
      }
      onComplete == null ? void 0 : onComplete();
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
  static async collect(source, options = {}) {
    const results = [];
    await Loom.run(source, (v) => {
      results.push(v);
    }, options);
    return results;
  }
  /**
   * Run multiple Braids concurrently, each with its own handler.
   * Returns when *all* complete.
   */
  static async runAll(pairs, options = {}) {
    await Promise.all(pairs.map(([source, handler]) => Loom.run(source, handler, options)));
  }
}
async function* chain(...sources) {
  for (const src of sources) {
    yield* src;
  }
}
function merge(...fibers) {
  return new Fiber(
    async function* () {
      const gens = fibers.map((f) => f.spawn());
      const advance = (gen, idx) => gen.next().then((r) => ({ value: r.value, done: !!r.done, idx }));
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
function zip(a, b) {
  return new Braid([a, b]).bind((t) => t);
}
function partition(fiber, pred) {
  const trueQueue = [];
  const falseQueue = [];
  const resolvers = [];
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
  const makeReader = (queue) => new Fiber(async function* () {
    while (true) {
      if (queue.length > 0) {
        yield queue.shift();
      } else if (sourceDone) {
        return;
      } else {
        await new Promise((res) => resolvers.push(res));
      }
    }
  });
  return [makeReader(trueQueue), makeReader(falseQueue)];
}
class BraidError extends Error {
  constructor(message) {
    super(message);
    this.name = "BraidError";
  }
}
class BraidTimeoutError extends BraidError {
  constructor(message) {
    super(message);
    this.name = "BraidTimeoutError";
  }
}
function fromArray(values, name) {
  return new Fiber(
    async function* () {
      for (const v of values) yield v;
    },
    { name: name ?? "fromArray" }
  );
}
function counter(start = 0, intervalMs = 0, name) {
  return new Fiber(
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
function interval(value, intervalMs, name) {
  return new Fiber(
    async function* () {
      while (true) {
        await new Promise((r) => setTimeout(r, intervalMs));
        yield typeof value === "function" ? value() : value;
      }
    },
    { name: name ?? "interval" }
  );
}
function just(value, name) {
  return new Fiber(
    async function* () {
      yield value;
    },
    { name: name ?? "just" }
  );
}
exports.Braid = Braid;
exports.BraidError = BraidError;
exports.BraidTimeoutError = BraidTimeoutError;
exports.Fiber = Fiber;
exports.Loom = Loom;
exports.Tension = Tension;
exports.chain = chain;
exports.counter = counter;
exports.fromArray = fromArray;
exports.interval = interval;
exports.just = just;
exports.merge = merge;
exports.partition = partition;
exports.zip = zip;
//# sourceMappingURL=braid.cjs.map
