import type { PaperExperimentDetail } from '../../../../packages/shared/src/paper-experiment-contracts';

/** This edition has no built-in strategies, so no run carries their notice. */
export function NativeRunNotice(_props: { detail: PaperExperimentDetail }) {
  return null;
}
