/**
 * Braid - A Language-Agnostic Co-routine Framework
 * 
 * @module braid
 */

// Re-export all public API from braid.ts
export {
    // Enums
    Tension,

    // Classes
    Fiber,
    Braid,
    Loom,

    // Combinators
    chain,
    merge,
    zip,
    partition,

    // Error classes
    BraidError,
    BraidTimeoutError,

    // Factory functions
    fromArray,
    counter,
    interval,
    just,
} from './braid';

// Re-export types separately (required for isolatedModules)
export type {
    Strand,
    Tuple,
    FiberOptions,
    BraidOptions,
    LoomOptions,
} from './braid';

