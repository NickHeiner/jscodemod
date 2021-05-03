import {Codemod} from '../../../';
import babelPlugin, {TODO} from './babel-plugin';
import {parse as babelParse, TransformOptions, transformSync} from '@babel/core';
import {parse, print} from 'recast';
import _ from 'lodash';
import type {Visitor} from '@babel/traverse';

const codemod: Codemod = {
  transform({source, filePath}: {source: string, filePath: string}) {
    const getBabelOpts = (plugins: Exclude<TransformOptions['plugins'], null> = []): TransformOptions => ({
      filename: filePath,
      plugins: [...plugins, '@babel/plugin-syntax-optional-chaining', '@babel/plugin-syntax-typescript', babelPlugin],
      ast: true
    });
    
    const parser = {
      parse(source: string, opts: Record<string, unknown>) {
        return babelParse(source, {
          ...getBabelOpts(),
          ..._.omit(
            opts, 
            'jsx', 'loc', 'locations', 'range', 'comment', 'onComment', 'tolerant', 'ecmaVersion'
          )
        });
      }
    };
    
    const ast = parse(source, {parser});

    const setAst = (): {visitor: Visitor<TODO>} => ({
      visitor: {
        Program(path) {
          path.replaceWith(ast.program);
        }
      }
    });

    const result = transformSync('', getBabelOpts([setAst]));
    if (!result) {
      throw new Error(`Transforming "${filePath}" resulted in a null babel result.`);
    }

    // @ts-ignore
    return print(result.ast).code;
  }
};

export default codemod;