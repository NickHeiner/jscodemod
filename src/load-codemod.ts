import {Codemod} from './types';

function loadCodemod(codemodPath: string): Codemod {
  // We need a dynamic require here.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const codemod = require(codemodPath);

  return codemod.default || codemod;
}

export default loadCodemod;