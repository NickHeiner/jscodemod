import { makePhaseError } from './run-codemod-on-file';
import {Codemod} from './types';

function loadCodemod(codemodPath: string): Codemod {
  let codemod;

  try {
    // We need a dynamic require here.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    codemod = require(codemodPath);
  } catch (e) {
    throw makePhaseError(
      e, 
      'loading your codemod', 
      'Figure out why your codemod throws an error when require()d. If your codemod is written in TS, do you have TS' +
      " configured to compile to a JS version that your Node version doesn't support?"
    );
  }
  
  return codemod.default || codemod;
}

export default loadCodemod;