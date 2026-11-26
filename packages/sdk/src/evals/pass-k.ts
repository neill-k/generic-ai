/**
 * pass^k: the probability that k independent attempts in a row all pass.
 *
 * This is the reliability figure a production agent needs (it must be right
 * every time it runs), and it falls quickly when the pass rate is below 1. It
 * is not pass@k (at least one of k attempts passes), which rises with k.
 *
 * With n >= k observed attempts and c passes, the unbiased estimate is
 * C(c, k) / C(n, k). With fewer attempts than k it falls back to (c / n)^k.
 */
export function estimatePassHatK(passCount: number, trialCount: number, k: number): number {
  if (trialCount <= 0 || k <= 0) {
    return 0;
  }
  const passes = Math.max(0, Math.min(passCount, trialCount));
  if (trialCount < k) {
    return (passes / trialCount) ** k;
  }
  let value = 1;
  for (let index = 0; index < k; index += 1) {
    value *= (passes - index) / (trialCount - index);
    if (value <= 0) {
      return 0;
    }
  }
  return value;
}
