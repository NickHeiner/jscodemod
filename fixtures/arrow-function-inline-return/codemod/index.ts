// To run this codemod from the jscodemod repo while developing locally, change this import to:
// import {Codemod} from '../../..';
import {Codemod} from '@nth/jscodemod';

import babelPlugin from './babel-plugin';
import babel from '@babel/core';
import {parse, print} from 'recast';

const codemod: Codemod = {
  transform({source, filePath}: {source: string, filePath: string}) {
    const ast = parse(source, {parser: babel});
    const result = babel.transformFromAstSync(ast, source, {
      filename: filePath,
      plugins: ['@babel/plugin-syntax-optional-chaining', '@babel/plugin-syntax-typescript', babelPlugin],
      ast: true
    });
    if (!result) {
      throw new Error(`Transforming "${filePath}" resulted in a null babel result.`);
    }

    // @ts-ignore
    return print(result.ast).code;
  }
};

export default codemod;