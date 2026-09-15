export type Rng = () => number;

/** Small deterministic PRNG (mulberry32). Returns floats in [0, 1). */
export function mulberry32(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer in [min, max], both inclusive. */
export function randInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  if (items.length === 0) throw new Error('pick() called with an empty list');
  return items[Math.floor(rng() * items.length)];
}

/** Lowercase hex string of exactly `length` characters. */
export function randHex(rng: Rng, length: number): string {
  let out = '';
  while (out.length < length) {
    out += Math.floor(rng() * 0x100000000)
      .toString(16)
      .padStart(8, '0');
  }
  return out.slice(0, length);
}

/** Deterministic Fisher-Yates shuffle (returns a new array). */
export function shuffle<T>(rng: Rng, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
