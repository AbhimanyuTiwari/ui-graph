/** Cheap token estimate for budgeting query answers (~4 chars per token). */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}
