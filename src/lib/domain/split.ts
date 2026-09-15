function assertInteger(name: string, value: number, min: number): void {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new RangeError(`${name} must be an integer >= ${min}`);
  }
}

/** Even split with the remainder going to the first parts: `splitCounts(100, 3)` -> `[34, 33, 33]`. */
export function splitCounts(total: number, parts: number): number[] {
  assertInteger('total', total, 0);
  assertInteger('parts', parts, 1);
  const base = Math.floor(total / parts);
  const remainder = total % parts;
  return Array.from({ length: parts }, (_, index) => base + (index < remainder ? 1 : 0));
}

/**
 * One target per item, in contiguous blocks in target order:
 * `evenSplitAssignments(5, ['a', 'b'])` -> `['a', 'a', 'a', 'b', 'b']`. Throws when there are items
 * but no targets.
 */
export function evenSplitAssignments<T>(total: number, targets: readonly T[]): T[] {
  assertInteger('total', total, 0);
  if (total === 0) return [];
  const counts = splitCounts(total, targets.length);
  const assignments: T[] = [];
  counts.forEach((count, index) => {
    for (let i = 0; i < count; i += 1) assignments.push(targets[index]);
  });
  return assignments;
}
