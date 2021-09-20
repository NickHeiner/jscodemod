import {Codemod} from '@nick.heiner/jscodemod';

// Compiling this will not work automatically, because no TSC will be found.

const codemod: Codemod = {
  getPlugin: () => () => ({
    visitor: {
      Identifier(path) {
        path.node.name = path.node.name.split('').reverse().join('');
      }
    }
  }),

  babelTransformOptions: {
    generatorOpts: {
      compact: true,
    }
  }
};

export default codemod;