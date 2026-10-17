/**
 * Stable node IDs. A node's id is a hash of semantic parts (route path,
 * component selector, control name, accessible name...) — never line numbers
 * or DOM positions — so IDs survive refactors and diffs stay meaningful.
 */
import { createHash } from 'node:crypto';

export function stableId(kind: string, ...parts: Array<string | undefined>): string {
  const h = createHash('sha1')
    .update([kind, ...parts.map((p) => p ?? '')].join('\u0000'))
    .digest('hex');
  return `${kind}_${h.slice(0, 12)}`;
}

export function contentHash(content: string): string {
  return createHash('sha1').update(content).digest('hex').slice(0, 16);
}
