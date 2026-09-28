/** Numerical Student-t tails (regularized incomplete beta), no dependencies. */
function logGamma(z: number): number {
  const c = [676.5203681218851, -1259.1392167224028, 771.3234287776531,
    -176.6150291621406, 12.507343278686905, -.13857109526572012,
    9.984369578019572e-6, 1.5056327351493116e-7];
  if (z < .5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - logGamma(1 - z);
  z -= 1;
  let x = .99999999999980993;
  for (let i = 0; i < c.length; i++) x += c[i]! / (z + i + 1);
  const t = z + 7.5;
  return .5 * Math.log(2 * Math.PI) + (z + .5) * Math.log(t) - t + Math.log(x);
}
function fraction(a: number, b: number, x: number): number {
  const tiny = 1e-300;
  let c = 1, d = 1 - (a + b) * x / (a + 1);
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    let aa = m * (b - m) * x / ((a + 2 * m - 1) * (a + 2 * m));
    d = 1 + aa * d; if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c; if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d; h *= d * c;
    aa = -(a + m) * (a + b + m) * x / ((a + 2 * m) * (a + 2 * m + 1));
    d = 1 + aa * d; if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c; if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const step = d * c; h *= step;
    if (Math.abs(step - 1) < 3e-14) return h;
  }
  throw new Error('incomplete beta did not converge');
}
function beta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log1p(-x));
  return x < (a + 1) / (a + b + 2) ? bt * fraction(a, b, x) / a : 1 - bt * fraction(b, a, 1 - x) / b;
}
export function studentTCdf(t: number, df: number): number {
  if (!Number.isFinite(df) || df <= 0 || !Number.isFinite(t)) throw new Error('finite t and positive df required');
  const tail = .5 * beta(df / (df + t * t), df / 2, .5);
  return t >= 0 ? 1 - tail : tail;
}
const criticalCache = new Map<string, number>();
export function studentTCritical(df: number, contrasts = 1): number {
  if (!Number.isFinite(df) || df <= 0 || !Number.isInteger(contrasts) || contrasts < 1) throw new Error('positive df and contrast count required');
  const key = `${df}/${contrasts}`;
  const cached = criticalCache.get(key); if (cached !== undefined) return cached;
  const p = 1 - .05 / (2 * contrasts);
  let lo = 0, hi = 2;
  while (studentTCdf(hi, df) < p) { hi *= 2; if (hi > 1e12) throw new Error('unsupported t quantile'); }
  for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (studentTCdf(mid, df) < p) lo = mid; else hi = mid; }
  const result = (lo + hi) / 2; criticalCache.set(key, result); return result;
}
