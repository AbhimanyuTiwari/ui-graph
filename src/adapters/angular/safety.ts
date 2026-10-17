/**
 * Safety classification for extracted actions. The crawler and probe runner
 * refuse to trigger anything that is not 'safe', so this errs on the side of
 * escalation: destructive wording on the triggering element always wins.
 */
import type { ActionNode, Safety } from '../../types.js';
import { DESTRUCTIVE_TEXT } from '../../schemas.js';

export interface ClassifyInput {
  type: ActionNode['type'];
  /** HTTP method for api actions. */
  method?: string;
  /** Handler name ('UserDetailComponent.onDelete'). */
  handler?: string;
  /** Accessible name / visible text of the triggering element. */
  elementText?: string;
}

/** Base class from the action shape alone. */
function baseSafety(input: ClassifyInput): Safety {
  switch (input.type) {
    case 'api': {
      const method = (input.method ?? '').toUpperCase();
      if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return 'safe';
      if (method === 'DELETE') return 'destructive';
      if (method === 'POST' || method === 'PUT' || method === 'PATCH') return 'mutate';
      return 'unknown';
    }
    case 'navigate':
    case 'dialog':
    case 'external':
    case 'download':
    case 'state':
      return 'safe';
    case 'unknown':
      return 'unknown';
  }
}

/**
 * Classify an action. Destructive wording (DESTRUCTIVE_TEXT) on the element
 * text or handler name escalates to 'destructive'; nothing ever de-escalates.
 */
export function classify(input: ClassifyInput): Safety {
  const text = `${input.elementText ?? ''} ${input.handler ?? ''}`;
  if (DESTRUCTIVE_TEXT.test(text)) return 'destructive';
  return baseSafety(input);
}
