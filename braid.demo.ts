/**
 * ============================================================
 *  🧶 BRAID — Demo & Tests
 * ============================================================
 * Run with: npx ts-node braid.demo.ts
 * Or compile: npx tsc braid.ts braid.demo.ts --target ES2020 --module commonjs --outDir dist
 */

import {
  Fiber, Braid, Tension, Loom,
  fromArray, counter, interval, just,
  merge, zip, partition, chain,
} from "./braid";

// ─── helpers ─────────────────────────────────────────────────
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log   = (label: string, v: unknown) =>
  console.log(`  [${label}]`, JSON.stringify(v));

async function section(title: string, fn: () => Promise<void>) {
  console.log(`\n${"─".repeat(56)}`);
  console.log(`  ${title}`);
  console.log(`${"─".repeat(56)}`);
  await fn();
}

// ─────────────────────────────────────────────────────────────
//  1. TIGHT BRAID  — lock-step synchronization
// ─────────────────────────────────────────────────────────────
await section("1. Tight Braid — lock-step", async () => {
  const letters = fromArray(["A", "B", "C"], "letters");
  const numbers = fromArray([1, 2, 3], "numbers");

  const braid = new Braid([letters, numbers]);

  // The Loom collects all emitted tuples
  const results = await Loom.collect(braid);
  console.log("  Tuples:", results);
  // → [["A",1], ["B",2], ["C",3]]
});

// ─────────────────────────────────────────────────────────────
//  2. LOOSE BRAID  — non-blocking, caches last value
// ─────────────────────────────────────────────────────────────
await section("2. Loose Braid — fluid / cached values", async () => {
  let fastCount = 0;
  let slowCount = 0;

  const fast = new Fiber(async function* () {
    for (let i = 0; i < 5; i++) {
      fastCount++;
      yield `tick-${i}`;
      await sleep(20);
    }
  }, { name: "fast" });

  const slow = new Fiber(async function* () {
    for (const headline of ["🐂 Bullish", "🐻 Bearish"]) {
      slowCount++;
      yield headline;
      await sleep(80);
    }
  }, { name: "slow" });

  const loose = new Braid([fast, slow], { tension: Tension.Loose });
  const results = await Loom.collect(loose);
  console.log("  Snapshots:");
  results.forEach((r) => log("snapshot", r));
  console.log(`  fast ticked ${fastCount}x, slow ${slowCount}x`);
});

// ─────────────────────────────────────────────────────────────
//  3. FRAYED BRAID  — strict fault intolerance
// ─────────────────────────────────────────────────────────────
await section("3. Frayed Braid — stops on first exhaustion", async () => {
  const short = fromArray([1, 2], "short");     // done after 2
  const long  = fromArray([10, 20, 30], "long"); // would continue

  const frayed = new Braid([short, long], { tension: Tension.Frayed });
  const results = await Loom.collect(frayed);
  console.log("  Results (stops when any strand is done):", results);
  // → [[1,10],[2,20]]  — stops as soon as 'short' is exhausted
});

// ─────────────────────────────────────────────────────────────
//  4. BIND  — transform braid output into a new Fiber
// ─────────────────────────────────────────────────────────────
await section("4. bind() — composing a Braid into a Fiber", async () => {
  const prices = fromArray([100, 101, 99, 103], "price");
  const labels = fromArray(["AAPL", "AAPL", "AAPL", "AAPL"], "ticker");

  const dashboard: Fiber<string> = new Braid([prices, labels])
    .bind(([price, ticker]) => `${ticker}: $${price}`);

  // dashboard is now a plain Fiber — it can be woven into yet
  // another Braid, or run standalone.
  const lines = await Loom.collect(dashboard);
  lines.forEach((l) => console.log(" ", l));
});

// ─────────────────────────────────────────────────────────────
//  5. PLAIT  — adding a strand to a running Braid
// ─────────────────────────────────────────────────────────────
await section("5. plait() — dynamic strand addition", async () => {
  const a = fromArray([1, 2, 3], "a");
  const b = fromArray(["x", "y", "z"], "b");
  const c = fromArray([true, false, true], "c");

  // Start with two strands, add a third via plait
  const braid = new Braid<[number, string]>([a, b]).plait(c);
  const results = await Loom.collect(braid);
  console.log("  3-strand tuples:", results);
});

// ─────────────────────────────────────────────────────────────
//  6. FIBER COMBINATORS  — map, filter, take
// ─────────────────────────────────────────────────────────────
await section("6. Fiber combinators — map / filter / take", async () => {
  const nums = counter(0);  // infinite: 0, 1, 2, 3 ...

  const processed = nums
    .filter((n) => n % 2 === 0)   // only evens
    .map((n) => n * 10)            // multiply
    .take(5);                      // stop after 5

  const results = await Loom.collect(processed);
  console.log("  evens × 10, first 5:", results);
  // → [0, 20, 40, 60, 80]
});

// ─────────────────────────────────────────────────────────────
//  7. MERGE  — fan-in (race / unordered)
// ─────────────────────────────────────────────────────────────
await section("7. merge() — unordered fan-in", async () => {
  const a = new Fiber(async function* () {
    yield "a1"; await sleep(30); yield "a2";
  });
  const b = new Fiber(async function* () {
    await sleep(10); yield "b1"; await sleep(10); yield "b2";
  });

  const merged = merge(a, b);
  const results = await Loom.collect(merged);
  console.log("  Merged (arrival order):", results);
  // → ["a1","b1","b2","a2"]  arrival order may vary
});

// ─────────────────────────────────────────────────────────────
//  8. BRAID OF BRAIDS  — deep composition
// ─────────────────────────────────────────────────────────────
await section("8. Braid of Braids — deep composition", async () => {
  // Inner braid: pairs of numbers
  const innerBraid = new Braid([
    fromArray([1, 2, 3], "x"),
    fromArray([4, 5, 6], "y"),
  ]).bind(([x, y]) => x + y);   // → Fiber<number>: 5, 7, 9

  // Outer braid: combine with a label fiber
  const labels    = fromArray(["sum1", "sum2", "sum3"], "label");
  const outerBraid = new Braid([innerBraid, labels])
    .bind(([sum, lbl]) => `${lbl} = ${sum}`);

  const results = await Loom.collect(outerBraid);
  results.forEach((r) => console.log(" ", r));
});

// ─────────────────────────────────────────────────────────────
//  9. FRAY  — snapshot & stop
// ─────────────────────────────────────────────────────────────
await section("9. fray() — stop and snapshot", async () => {
  const a = counter(0, 10, "a");
  const b = counter(100, 10, "b");

  const braid = new Braid([a, b]);
  let snapshot: unknown;

  await Loom.run(braid, ([va, vb], i) => {
    log(`round ${i}`, [va, vb]);
    if (i === 2) {
      snapshot = braid.fray();  // stop after 3 rounds
    }
  });

  console.log("  Snapshot at stop:", snapshot);
});

// ─────────────────────────────────────────────────────────────
//  10. PARTITION  — split a fiber by predicate
// ─────────────────────────────────────────────────────────────
await section("10. partition() — split by predicate", async () => {
  const nums = fromArray([1, 2, 3, 4, 5, 6], "nums");
  const [evens, odds] = partition(nums, (n) => n % 2 === 0);

  // Consume both concurrently via a Tight Braid
  const braid = new Braid([evens.take(3), odds.take(3)]);
  const results = await Loom.collect(braid);
  console.log("  [even, odd] pairs:", results);
});

// ─────────────────────────────────────────────────────────────
//  11. LOOM.runAll  — concurrent independent Braids
// ─────────────────────────────────────────────────────────────
await section("11. Loom.runAll — concurrent Braids", async () => {
  const braidA = new Braid([fromArray(["🔴", "🔴", "🔴"], "a"), fromArray([1, 2, 3], "na")]);
  const braidB = new Braid([fromArray(["🔵", "🔵", "🔵"], "b"), fromArray([4, 5, 6], "nb")]);

  const logs: string[] = [];
  await Loom.runAll([
    [braidA, ([c, n]) => { logs.push(`A: ${c}${n}`); }],
    [braidB, ([c, n]) => { logs.push(`B: ${c}${n}`); }],
  ]);
  console.log("  Results:", logs);
});

// ─────────────────────────────────────────────────────────────
//  12. REAL-WORLD SCENARIO: Ticker + News feed
// ─────────────────────────────────────────────────────────────
await section("12. Real-world: stock ticker + news feed (Loose)", async () => {
  let price = 150;
  const ticker = new Fiber(async function* () {
    for (let i = 0; i < 6; i++) {
      yield price += Math.round((Math.random() - 0.5) * 4);
      await sleep(15);
    }
  }, { name: "ticker" });

  const news = new Fiber(async function* () {
    yield "📰 Earnings beat estimates";
    await sleep(50);
    yield "📰 Fed holds rates steady";
  }, { name: "news" });

  const feed = new Braid([ticker, news], { tension: Tension.Loose })
    .bind(([p, headline]) => `$${p}  ·  ${headline}`);

  await Loom.run(feed, (update) => console.log(" ", update));
});

console.log("\n✅ All demos complete.\n");
