# 🧶 Braid

A Language-Agnostic Co-routine Framework for weaving independent asynchronous "strands" into synchronized cords.

## Installation

```bash
npm install braid
# or
yarn add braid
# or
pnpm add braid
```

## Usage

```typescript
import { Braid, Loom, Fiber, Tension, fromArray, counter, interval, just } from 'braid';

// Create Fibers from various sources
const letters = fromArray(['A', 'B', 'C'], 'letters');
const numbers = fromArray([1, 2, 3], 'numbers');

// Weave them together with a Braid
const braid = new Braid([letters, numbers]);

// Collect all emitted tuples
const results = await Loom.collect(braid);
// → [["A",1], ["B",2], ["C",3]]

// Or use in for await loops
for await (const [letter, number] of braid) {
  console.log(`${letter}: ${number}`);
}
```

## Core Concepts

### Fiber

A Fiber wraps any `AsyncGenerator` and gives it an identity. It's the atom of the Braid.

```typescript
const fiber = new Fiber(async function* () {
  yield 1;
  yield 2;
  yield 3;
}, { name: 'myFiber' });
```

Fibers have built-in combinators:
- `map(fn)` - Transform values
- `filter(pred)` - Filter by predicate
- `take(n)` - Limit to n values
- `prepend(seed)` - Emit seed before starting

### Braid

A Braid weaves N Fibers together with different tension modes:

```typescript
// TIGHT (default) - Lock-step synchronization
const tight = new Braid([fiberA, fiberB]);

// LOOSE - Non-blocking, uses last known value
const loose = new Braid([fastFiber, slowFiber], { 
  tension: Tension.Loose 
});

// FRAYED - Strict fault intolerance
const frayed = new Braid([fiberA, fiberB], { 
  tension: Tension.Frayed 
});
```

### Loom

The Loom is the executor that runs a Braid to completion.

```typescript
// Run with handler
await Loom.run(braid, (value, index) => {
  console.log(`[${index}]`, value);
});

// Collect to array
const results = await Loom.run(braid);

// Run multiple concurrently
await Loom.runAll([
  [braidA, handlerA],
  [braidB, handlerB],
]);
```

## API Reference

### Classes

- `Fiber<T>` - Single async strand wrapper
- `Braid<Ts>` - Woven collection of Fibers  
- `Loom` - Executor for running Braids

### Enums

- `Tension.Tight` - Atomic lock-step (default)
- `Tension.Loose` - Non-blocking, cached values
- `Tension.Frayed` - Strict fault intolerance

### Combinators

- `merge(...fibers)` - Fan-in, unordered
- `zip(a, b)` - Binary zip into pairs
- `chain(...sources)` - Sequential interleaving
- `partition(fiber, pred)` - Split by predicate

### Factory Functions

- `fromArray(values)` - Create from array
- `counter(start, intervalMs)` - Infinite counter
- `interval(value, intervalMs)` - Periodic emitter
- `just(value)` - Single value

### Error Classes

- `BraidError` - Base error
- `BraidTimeoutError` - Timeout error for Frayed mode

## License

MIT

