import { PhaseError } from './types';

export function makePhaseError<E extends Error>(
  err: E,
  phase: PhaseError['phase'],
  suggestion: PhaseError['suggestion']
): E & Pick<PhaseError, 'phase' | 'suggestion'> {
  Object.assign(err, { phase, suggestion });
  return err as E & Pick<PhaseError, 'phase' | 'suggestion'>;
}
