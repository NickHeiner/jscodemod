import getLogger from './get-logger';
import piscina from 'piscina';
import fs from 'fs';
import loadCodemod from './load-codemod';
import type {CodemodResult, TODO} from './types';
import _ from 'lodash';
import getCodemodName from './get-codemod-name';
import {
  parse as babelParse, 
  transformSync as babelTransformSync, 
  Visitor, 
  TransformOptions
} from '@babel/core';
import * as recast from 'recast';

const baseLog = getLogger({
  name: 'jscodemod-worker',
  ...piscina.workerData.logOpts
});

const pFs = fs.promises;

/**
 * I don't think we can share this instance across workers – I got an error that said the transform function 
 * "could not be cloned" when I tried to pass the codemod itself on `workerData`.
 */
const codemod = loadCodemod(piscina.workerData.codemodPath);

export type CodemodMetaResult = {
  filePath: string;
  codeModified: boolean;
  fileContents: string;
}
export default async function main(sourceCodeFile: string): Promise<CodemodMetaResult> {
  const log = baseLog.child({sourceCodeFile});
  const codemodName = getCodemodName(codemod, piscina.workerData.codemodPath);
  log.debug({action: 'start', codemod: codemodName});

  const originalFileContents = await pFs.readFile(sourceCodeFile, 'utf-8');
  const rawArgs = piscina.workerData.codemodArgs ? JSON.parse(piscina.workerData.codemodArgs) : undefined;
  const parsedArgs = await codemod.parseArgs?.(rawArgs);

  let transformedCode: CodemodResult;
  let threwError = false;

  const handleError = (e: Error, messageSuffix: string) => {
    threwError = true;
    log.error({error: _.pick(e, 'message', 'stack')}, `Codemod "${codemodName}" threw an error ${messageSuffix}`);
  };

  const codemodOpts = {
    source: originalFileContents, 
    filePath: sourceCodeFile, 
    commandLineArgs: parsedArgs,
  };

  if (codemod.transform) {
    try {
      transformedCode = await codemod.transform(codemodOpts);
    } catch (e) {
      handleError(e, 'for a file');
    }
  } else {
    // TODO: This can probably be cleaned up.
    // TODO: This makes some excessive changes:
    //    * Paren insertion: https://github.com/benjamn/recast/issues/914
    //    * Reformatting `return\n(expr)` to `return expr`. This doesn't repro with recast-only.
    //    * If a file is entirely commented out, it'll be deleted.
    //    * A trailing comment will have a space removed:
    //          `a; /*f*/` => `a;/*f*/`
    // 
    // The impact of this would be reduced if we detected when the AST is unchanged, and then did not write new
    // file contents. However, this proved difficult to do.
    // 
    // eslint-disable-next-line max-len
    // Maybe we want the parserOverrides approach: https://github.com/codemod-js/codemod/blob/06310982b67783e9d2861a7737c7810396417bd3/packages/core/src/RecastPlugin.ts.

    let codemodPlugins; 
    try {
      codemodPlugins = await codemod.getPlugin(codemodOpts);
    } catch (e) {
      handleError(e, 'when callling codemod.getPlugin()');
    }
    
    const pluginsToUse = Array.isArray(codemodPlugins) ? codemodPlugins : [codemodPlugins]; 

    const getBabelOpts = (extraPlugins: Exclude<TransformOptions['plugins'], null> = []): TransformOptions => ({
      filename: sourceCodeFile,
      plugins: [...extraPlugins, ...pluginsToUse],
      ast: true
    });

    const parser = {
      parse(source: string, opts: Record<string, unknown>) {
        return babelParse(source, {
          ...getBabelOpts(),
          ..._.pick(codemod, 'presets'),
          // There are options that are recognized by recast but not babel. Babel errors when they're passed. To avoid
          // this, we'll omit them.
          ..._.omit(
            opts, 
            'jsx', 'loc', 'locations', 'range', 'comment', 'onComment', 'tolerant', 'ecmaVersion'
          )
        });
      }
    };

    const ast = recast.parse(originalFileContents, {parser});

    const setAst = (): {visitor: Visitor<TODO>} => ({
      visitor: {
        Program(path) {
          path.replaceWith(ast.program);
        }
      }
    });

    // result.ast.end will be 0, and ast.end is originalFileContents.length.
    // Passing originalFileContents instead of '' solves that problem, but causes some other problem.
    const result = babelTransformSync('', getBabelOpts([setAst]));
    if (!result) {
      throw new Error(`Transforming "${sourceCodeFile}" resulted in a null babel result.`);
    }

    transformedCode = recast.print(result.ast as recast.types.ASTNode).code;

    if (originalFileContents.endsWith('\n') && !transformedCode.endsWith('\n')) {
      transformedCode += '\n';
    }    
  }

  const codeModified = Boolean(transformedCode && transformedCode !== originalFileContents);

  const {writeFiles} = piscina.workerData; 
  if (codeModified && writeFiles) {
    // This non-null assertion is safe because `codeModified` includes a check on `transformedCode`.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    await pFs.writeFile(sourceCodeFile, transformedCode!);
  }
  log.debug({action: threwError ? 'error' : codeModified ? 'modified' : 'skipped', writeFiles});
  return {
    codeModified, 
    fileContents: transformedCode ? transformedCode : originalFileContents,
    filePath: sourceCodeFile
  };
}