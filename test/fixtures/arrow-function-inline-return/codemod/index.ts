import {Codemod} from '../../../types';
import babelPlugin from './babel-plugin';
import babel from '@babel/core';

const codemod: Codemod = {
  transform({source, filePath}) {
    const {ast} = babel.transformSync(source, {
      filename: filePath,
      plugins: ['@babel/plugin-proposal-optional-chaining'],
      ast: true
    });
    
    return babel.transformFromAstSync(ast, source, )
  }
};