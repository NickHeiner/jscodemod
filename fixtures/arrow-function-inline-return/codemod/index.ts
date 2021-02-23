// To run this codemod from the jscodemod repo while developing locally, change this import to:
// import {Codemod} from '../../..';
import {Codemod} from '@nth/jscodemod';

import babelPlugin from './babel-plugin';
import {transformSync} from '@babel/core';

const codemod: Codemod = {
  transform({source, filePath}) {
    return transformSync(source, {
      filename: filePath,
      plugins: ['@babel/plugin-syntax-optional-chaining', '@babel/plugin-syntax-typescript', babelPlugin],
      ast: true
    })?.code;
  }
};

export default codemod;