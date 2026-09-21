// Pure chunking helpers. No I/O.

/**
 * Splits `items` into consecutive groups of at most `size`.
 * @template T
 * @param {T[]} items
 * @param {number} [size=40]
 * @returns {Array<Array<T>>}
 */
export function planChunks(items, size = 40) {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(`planChunks: size must be a positive integer, got ${size}`);
  }
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Maps index-aligned verdicts back onto clause ids.
 * @template {{flagged:boolean}} Verdict
 * @param {{id:string, text:string}[]} chunkClauses
 * @param {Verdict[]} verdicts  index-aligned with chunkClauses
 * @returns {Array<Verdict & {id:string}>}
 */
export function reattachVerdicts(chunkClauses, verdicts) {
  if (chunkClauses.length !== verdicts.length) {
    throw new Error(
      `reattachVerdicts: length mismatch — ${chunkClauses.length} clauses but ` +
      `${verdicts.length} verdicts. Refusing to guess an alignment; ` +
      `silently dropping verdicts would misplace highlights.`
    );
  }
  return chunkClauses.map((clause, i) => ({ ...verdicts[i], id: clause.id }));
}
