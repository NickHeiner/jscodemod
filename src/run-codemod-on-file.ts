import type {NTHLogger} from 'nth-log';
import fs from 'fs';
import type {CodemodResult, DetectLabel, Codemod, TODO} from './types';
import {serializeError} from 'serialize-error';
import _ from 'lodash';
import {parse as babelParse, transformSync as babelTransformSync, transformFromAstSync as babelTransformFromAstSync, Visitor, TransformOptions} from '@babel/core';
import * as recast from 'recast';

// I wonder if we could measure perf gains by trimming this import list.

const pFs = fs.promises;

/**
 * I don't think we can share this instance across workers – I got an error that said the transform function 
 * "could not be cloned" when I tried to pass the codemod itself on `workerData`.
 */

export type BaseCodemodMeta = {
  filePath: string;
  fileContents: string;
  debugEntries: unknown[]
};

export type TransformMeta = {
  codeModified: boolean;
} & BaseCodemodMeta;

export type DetectMeta = {
  label?: DetectLabel;
} & BaseCodemodMeta;

export type ErrorMeta = {
  error: Error
} & BaseCodemodMeta;

export type CodemodMetaResult = TransformMeta | DetectMeta | ErrorMeta;

const makeLabeller = () => {
  let currentLabel: DetectLabel, currentLabelPriority = -Infinity;

  function applyLabel(priority: number, label: DetectLabel) {
    if (priority >= currentLabelPriority) {
      currentLabelPriority = priority;
      currentLabel = label;
    }
  }

  const getLabel = () => currentLabel === undefined ? undefined : `${currentLabelPriority} ${currentLabel}`;

  return {applyLabel, getLabel};
};

export default async function runCodemodOnFile(
  codemod: Codemod, sourceCodeFile: string, baseLog: NTHLogger, 
  {codemodArgs, writeFiles, alwaysTransform}: {codemodArgs?: string, writeFiles: boolean; alwaysTransform: boolean}
): Promise<CodemodMetaResult> {
  const log = baseLog.child({sourceCodeFile});
  log.debug({action: 'start'});

  // Keep using baseLog instead of log because NTHLogger .child() does not attach logPhase.
  // logPhase does not work well for sync operations.
  const perfLog = <T>(phase: string, fn: () => T): Promise<T> => baseLog.logPhase(
    {level: 'trace', phase},
    () => Promise.resolve(fn())
  );

  const originalFileContents = await pFs.readFile(sourceCodeFile, 'utf-8');
  const parsedArgs = await codemod.parseArgs?.(codemodArgs);

  const debugEntries: BaseCodemodMeta['debugEntries'] = [];
  const debugLog = (entry: unknown) => debugEntries.push(entry);

  const baseMeta = {
    fileContents: originalFileContents,
    filePath: sourceCodeFile,
    debugEntries
  };

  const labeller = makeLabeller();

  const codemodOpts = {
    source: originalFileContents, 
    filePath: sourceCodeFile, 
    commandLineArgs: parsedArgs,
    debugLog,
    ..._.pick(labeller, 'applyLabel')
  };

  let transformedCode;
  try {
    if ('presets' in codemod || 'getPlugin' in codemod) {
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

      const codemodPlugins = await codemod.getPlugin(codemodOpts);
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
    } else {
      transformedCode = await codemod.transform(codemodOpts);
    }
  } catch (e) {
    log.debug({e}, 'Codemod threw an error');
    return {
      error: serializeError(e),
      ...baseMeta
    };
  }

  if (codemod.detect && !alwaysTransform) {
    log.debug({action: 'detect', result: labeller.getLabel()});
    return {
      label: labeller.getLabel(),  
      ...baseMeta
    };
  }

  const codeModified = transformedCode !== undefined && transformedCode !== originalFileContents;
  if (codeModified && writeFiles) {
    // I originally had this cast inline but TS didn't recognize it.
    const truthyCodemodResult = transformedCode as CodemodResult;

    // This non-null assertion is safe because `codeModified` includes a check on `transformedCode`.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    await pFs.writeFile(sourceCodeFile, truthyCodemodResult!);
  }
  log.debug({action: codeModified ? 'modified' : 'skipped-write', writeFiles});

  return {
    ...baseMeta,
    codeModified, 
    fileContents: transformedCode ? transformedCode : originalFileContents
  };
}