import {Codemod} from '@nick.heiner/jscodemod';
import type {Visitor} from '@babel/traverse';

// TODO is our intentional any type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TODO = any;

const codemod: Codemod = {
  getPlugin: (): {visitor: Visitor<TODO>} => ({
    visitor: {
      Identifier(path) {
        path.node.name = path.node.name.split('').reverse().join('');
      }
    }
  }),

  babelTransformOptions: {
    generatorOpts: {
      retainFunctionParens: true,
    }
  }
};

export default codemod;