# Requirements

## Original goal
Implement a pure isAdult(age) function that returns whether age is at least 18, and verify AC-BOUNDARY for ages 17, 18, and 19.

## AC-BOUNDARY
For integer ages at the threshold boundary, `isAdult(age)` returns a boolean using the inclusive threshold 18.
- `isAdult(17) === false`
- `isAdult(18) === true`
- `isAdult(19) === true`

The function is synchronous and accepts one numeric age. This fixture does not define other validation or product behavior.
