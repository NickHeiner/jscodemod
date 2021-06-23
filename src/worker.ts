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
  action: 'error' | 'modified' | 'skipped';
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

  const codemodOpts = {
    source: originalFileContents, 
    filePath: sourceCodeFile, 
    commandLineArgs: parsedArgs
  };

  const transformFile = async (): Promise<CodemodResult> => {
    if (codemod.transform) {
      try {
        return codemod.transform(codemodOpts);
      } catch (e) {
        e.phase = 'codemod.transform()';
        e.suggestion = "Check your transform() method for a bug, or add this file to your codemod's ignore list.";
        throw e;
      }
    }

    let fileContentsForRecast = originalFileContents;
    let fileContentsPrefixToReattachPostTransform = '';
    if (originalFileContents.startsWith('#!')) {
      const shebangEndIndex = originalFileContents.indexOf('\n');
      fileContentsForRecast = originalFileContents.slice(shebangEndIndex);
      fileContentsPrefixToReattachPostTransform = originalFileContents.slice(0, shebangEndIndex);
      log.warn({shebangEndIndex, fileContentsPrefixToReattachPostTransform, fileContentsForRecast}, 'shebang prfix');
    } else {
      log.warn({originalFileContents}, 'no shebang prefix');
    }
    
    // The impact of erroneous changes would be reduced if we detected when the AST is unchanged, and then did not 
    // write new file contents. However, this proved difficult to do.
    // 
    // eslint-disable-next-line max-len
    // Maybe we want the parserOverrides approach: https://github.com/codemod-js/codemod/blob/06310982b67783e9d2861a7737c7810396417bd3/packages/core/src/RecastPlugin.ts.

    let codemodPlugins; 
    try {
      codemodPlugins = await codemod.getPlugin(codemodOpts);
    } catch (e) {
      e.phase = 'codemod.getPlugin()';
      e.suggestion = 'Check your getPlugin() method for a bug.';
      throw e;
    }
    
    const getBabelOpts = (plugins: Exclude<TransformOptions['plugins'], null> = []): TransformOptions => ({
      filename: sourceCodeFile,
      plugins,
      ast: true
    });

    const parser = {
      parse(source: string, opts: Record<string, unknown>) {
        const babelOpts = {
          ...getBabelOpts(),
          ..._.pick(codemod, 'presets'),
          // There are options that are recognized by recast but not babel. Babel errors when they're passed. To avoid
          // this, we'll omit them.
          ..._.omit(
            opts, 
            'jsx', 'loc', 'locations', 'range', 'comment', 'onComment', 'tolerant', 'ecmaVersion'
          ),
          /**
           * We must have babel emit tokens. Otherwise, recast will use esprima to tokenize, which won't have the 
           * user-provided babel config.
           * 
           * https://github.com/benjamn/recast/issues/834
           */
          parserOpts: {
            tokens: true
          }
        };
        log.trace({babelOpts});
        return babelParse(source, babelOpts);
      }
    };

    let ast: ReturnType<typeof recast.parse>; 
    try {
      ast = recast.parse(fileContentsForRecast, {parser});
    } catch (e) {
      e.phase = 'recast.parse using the settings you passed';
      e.suggestion = "Check that you passed the right babel preset in the codemod's `presets` field.";
      throw e;
    }

    const setAst = (): {visitor: Visitor<TODO>} => ({
      visitor: {
        Program(path) {
          path.replaceWith(ast.program);
        }
      }
    });

    const pluginsToUse = Array.isArray(codemodPlugins) ? codemodPlugins : [codemodPlugins]; 

    // result.ast.end will be 0, and ast.end is originalFileContents.length.
    // Passing originalFileContents instead of '' solves that problem, but causes some other problem.
    const result = babelTransformSync('', getBabelOpts([setAst, pluginsToUse]));
    if (!result) {
      const err = new Error(`Transforming "${sourceCodeFile}" resulted in a null babel result.`);
      Object.assign(err, {
        phase: 'running your codemod babel plugin',
        suggestion: "Check your plugin for a bug, or ignore this file in your codemod's ignore list."
      });
      throw err;
    }

    let transformedCode = 
      fileContentsPrefixToReattachPostTransform + '\n\n' + recast.print(result.ast as recast.types.ASTNode).code;

    if (originalFileContents.endsWith('\n') && !transformedCode.endsWith('\n')) {
      transformedCode += '\n';
    }  
    
    return transformedCode;
  };

  let transformedCode: CodemodResult = null;
  let threwError = false;

  try {
    transformedCode = await transformFile();
  } catch (e) {
    threwError = true;
    log.error({
      error: _.pick(e, 'message', 'stack', 'phase')
    }, `File ${sourceCodeFile}: Codemod "${codemodName}" threw an error during ${e.phase}. ${e.suggestion}`);
  }

  const codeModified = Boolean(transformedCode && transformedCode !== originalFileContents);

  const {writeFiles} = piscina.workerData; 
  if (codeModified && writeFiles) {
    // This non-null assertion is safe because `codeModified` includes a check on `transformedCode`.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    await pFs.writeFile(sourceCodeFile, transformedCode!);
  }
  const action = threwError ? 'error' : codeModified ? 'modified' : 'skipped';
  log.debug({action, writeFiles});
  return {
    action,
    codeModified, 
    fileContents: transformedCode ? transformedCode : originalFileContents,
    filePath: sourceCodeFile
  };
}