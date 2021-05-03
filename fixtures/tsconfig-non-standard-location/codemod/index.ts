import {Codemod} from '@nth/jscodemod';

const codemod: Codemod = {
  transform({source}) {
    return `/* prefix tsconfig-non-standard-location */\n${source}`;
  }
};

export default codemod;