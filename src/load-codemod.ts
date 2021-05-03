import {Codemod} from './types';
// import 'ts-node/register';
import {create} from 'ts-node';
import fs = require('fs');

const tsCompiler = create();

function loadCodemod(codemodPath: string): Codemod {
  // We need a dynamic require here.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const codemod = tsCompiler.compile(fs.readFileSync(codemodPath, 'utf8'), codemodPath);

  return codemod.default || codemod;
}

export default loadCodemod;