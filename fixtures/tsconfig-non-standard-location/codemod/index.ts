import {Codemod} from 'jscodemod';

// Compiling this will not work, because no TSC will be found.

const codemod: Codemod = {
  transform({source}) {
    return `/* prefix tsconfig-non-standard-location */\n${source}`;
  }
};

export default codemod;