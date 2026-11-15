// ---------------------------------------------------------
// Детерминированный ГПСЧ (mulberry32) + seed из строки
// Без внешних зависимостей, чтобы не возиться с ESM/CJS.
// ---------------------------------------------------------

export interface Rng {
  next: () => number;
  between: (a: number, b: number) => number;
  int: (a: number, b: number) => number;
  pick: <T>(arr: T[]) => T;
  chance: (p: number) => boolean;
}

function hashString(seed: string): number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

export function makeRng(seed: string): Rng {
  let state = hashString(seed);

  const next = (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    between: (a, b) => a + (b - a) * next(),
    int: (a, b) => Math.floor(a + (b - a + 1) * next()),
    pick: <T>(arr: T[]): T => arr[Math.floor(next() * arr.length)],
    chance: (p) => next() < p,
  };
}