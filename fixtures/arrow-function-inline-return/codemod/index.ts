/* @ts-nocheck */

import {Codemod} from '@nth/jscodemod';
import babelPlugin from './babel-plugin';
// import {parse as babelParse} from '@babel/core';
import {parse as babelParse, transformFromAstSync} from '@babel/core';
import {parse, print} from 'recast';
import _ from 'lodash';

const codemod: Codemod = {
  transform({source, filePath}: {source: string, filePath: string}) {
    const babelOpts = {
      filename: filePath,
      plugins: ['@babel/plugin-syntax-optional-chaining', '@babel/plugin-syntax-typescript', babelPlugin],
      ast: true
    };
    
    const parser = {
      parse(source: string, opts: Record<string, unknown>) {
        return babelParse(source, {
          ...babelOpts,
          ..._.omit(
            opts, 
            'jsx', 'loc', 'locations', 'range', 'comment', 'onComment', 'tolerant', 'ecmaVersion'
          )
        });
      }
    };
    
    const ast = parse(source, {parser});
    const result = transformFromAstSync(ast, source, babelOpts);
    if (!result) {
      throw new Error(`Transforming "${filePath}" resulted in a null babel result.`);
    }

    const fileName = require('path').basename(filePath);

    require('fs').writeFileSync(`/Users/nheiner/code/jscodemod/recast-${fileName}.json`, JSON.stringify(ast, null, 2));
    require('fs').writeFileSync(`/Users/nheiner/code/jscodemod/transformed-${fileName}.json`, JSON.stringify(result.ast, null, 2));

    // @ts-ignore
    return print(result.ast).code;

    // return print(ast).code;
  }
};

export default codemod;