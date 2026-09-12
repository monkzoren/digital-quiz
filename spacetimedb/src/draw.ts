// The pure half of the question draw: given the candidates, how many of
// tonight's seats have met each one, and how many questions the sheet needs,
// decide what goes up and in what order.
//
// It lives here rather than in index.ts because the module entrypoint may
// only export SpacetimeDB constructs, and this is worth testing on its own
// (see draw.test.mjs). index.ts owns the database side: which questions are
// candidates, who is sitting down, and the shuffle.

export type Candidate = { id: bigint; topicId: bigint };

/** Pick `count` questions, freshest first.
 *
 *  Candidates are banded by how many of tonight's seats have already been
 *  asked them. The draw empties the band nobody has seen before it touches
 *  the next, so a repeat only reaches the screen once nothing fresh is left,
 *  and when one must, a question a single regular half-remembers goes up
 *  before one the whole room can recite.
 *
 *  Inside a band, consecutive questions come from different topics where
 *  possible. Freshness outranks that spread: a band too small to alternate
 *  topics is still drawn from first.
 *
 *  `pool` is expected to be shuffled already — the order inside a band is
 *  the order it arrives in, so the caller's shuffle is what makes the draw
 *  random.
 *
 *  The sheet always comes back full: given fewer candidates than `count`
 *  (a host who picked one small home-made topic), the last resort is to go
 *  round them again and ask one twice in a sitting. That is a poor quiz, but
 *  a short sheet is worse than a poor one — the room reads its questions out
 *  of a fixed-length window and a short `drawn` leaves it stuck in the intro
 *  with nothing to put on screen. Only an empty `pool` returns nothing.
 */
export function pickSpread<T extends Candidate>(
  pool: T[],
  seenBy: Map<string, number>,
  count: number
): bigint[] {
  const bands = new Map<number, T[]>();
  for (const q of pool) {
    const n = seenBy.get(String(q.id)) ?? 0;
    const band = bands.get(n);
    if (band) band.push(q);
    else bands.set(n, [q]);
  }
  const out: bigint[] = [];
  let lastTopic: bigint | null = null;
  for (const n of [...bands.keys()].sort((a, b) => a - b)) {
    const band = bands.get(n)!;
    while (out.length < count && band.length) {
      let k = band.findIndex(q => q.topicId !== lastTopic);
      if (k < 0) k = 0;
      const q = band.splice(k, 1)[0];
      out.push(q.id);
      lastTopic = q.topicId;
    }
    if (out.length >= count) break;
  }
  // Not enough distinct questions in the whole pool to fill the sheet: go
  // round again rather than hand back a short one.
  if (out.length && out.length < count) {
    const cycle = [...out];
    for (let i = 0; out.length < count; i++) out.push(cycle[i % cycle.length]);
  }
  return out;
}
