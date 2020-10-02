import {Codemod} from '@nth/jscodemod';
import babelPlugin from './babel-plugin';
import {transformSync} from '@babel/core';

const codemod: Codemod = {
  transform({source, filePath}) {
    return transformSync(source, {
      filename: filePath,
      plugins: ['@babel/plugin-syntax-optional-chaining', babelPlugin],
      ast: true
    })?.code;
  }
};

export default codemod;