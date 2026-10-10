# Design

## Invariants
- `isAdult` is a pure function with no I/O or mutable state.
- The boundary is inclusive: the result is exactly the boolean value of `age >= 18`.
- The function is exported from the single ES module `subject.mjs`.
