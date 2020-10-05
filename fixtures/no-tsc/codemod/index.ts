import {Codemod} from '@nth/jscodemod';

// Compiling this will not work automatically, because no TSC will be found.

const codemod: Codemod = {
  transform({source}) {
    return `/* prefix no-tsc */\n${source}`;
  }
};

export default codemod;