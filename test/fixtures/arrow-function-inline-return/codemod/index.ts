import {Codemod} from '../../../../types';
import babelPlugin from './babel-plugin';
import babel from '@babel/core';

const codemod: Codemod = {
  transform({source, filePath}) {
    return babel.transformSync(source, {
      filename: filePath,
      plugins: ['@babel/plugin-syntax-optional-chaining', babelPlugin],
      ast: true
    }).code;
  }
};

export default codemod;