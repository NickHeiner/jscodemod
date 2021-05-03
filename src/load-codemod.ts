import {Codemod} from './types';

// This feels risky, because ts-node relies on a deprecated API: https://github.com/TypeStrong/ts-node/issues/1302.
// However, the API has been marked as deprecated for a long time, and hasn't been removed. And using ts-node
// is both a perf win, and allows me to remove a bunch of code from this project.
import 'ts-node/register';

function loadCodemod(codemodPath: string): Codemod {
  // We need a dynamic require here.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const codemod = require(codemodPath);

  return codemod.default || codemod;
}

export default loadCodemod;