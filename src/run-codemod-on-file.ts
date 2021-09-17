import type {NTHLogger} from 'nth-log';
import fs from 'fs';
import type {Codemod} from './types';
import {PromiseValue} from 'type-fest';
import _ from 'lodash';
import {
  parse as babelParse,
  transformSync as babelTransformSync,
  TransformOptions,
  PluginItem,
  PluginObj
} from '@babel/core';
import * as recast from 'recast';
import getCodemodName from './get-codemod-name';
import prettyMs from 'pretty-ms';
import assert from 'assert';

const pFs = fs.promises;

export type CodemodMetaResult<TransformResultMeta> = {
  meta: TransformResultMeta
  filePath: string;
} & ({
  action: 'modified' | 'skipped';
  codeModified: boolean;
  fileContents: string;
} | {
  action: 'error';
  error: Error;
})

export default async function runCodemodOnFile(
  codemod: Codemod, sourceCodeFile: string, baseLog: NTHLogger,
  {codemodArgs, codemodPath, writeFiles}: {codemodArgs?: string, writeFiles: boolean; codemodPath: string},
  runStartTimeMs: number
): Promise<CodemodMetaResult<unknown>> {
  const log = baseLog.child({sourceCodeFile});
  const codemodName = getCodemodName(codemod, codemodPath);
  const timeSinceRunStart = Date.now() - runStartTimeMs;
  log.trace({
    action: 'Codemod ready to start',
    codemod: codemodName,
    timeSinceRunStart,
    timeSinceRunStartPretty: prettyMs(timeSinceRunStart)
  });

  const originalFileContents = await log.logPhase(
    {phase: 'read file', level: 'trace'},
    () => pFs.readFile(sourceCodeFile, 'utf-8')
  );
  const rawArgs = codemodArgs ? JSON.parse(codemodArgs) : undefined;
  const parsedArgs = await log.logPhase({
    phase: 'parse args',
    level: 'trace'
    // TODO The types are messed up. A sync return to this method is fine.
    // @ts-expect-error
  }, () => codemod.parseArgs?.(rawArgs));

  const codemodOpts = {
    source: originalFileContents,
    filePath: sourceCodeFile,
    commandLineArgs: parsedArgs
  };

  const transformFile = async () => {
    if (codemod.transform) {
      try {
        return codemod.transform(codemodOpts);
      } catch (e) {
        e.phase = 'codemod.transform()';
        e.suggestion = "Check your transform() method for a bug, or add this file to your codemod's ignore list.";
        throw e;
      }
    }

    /**
     * Unfortunately, the workflow of using Recast and Babel together has some interactions that don't occur when using
     * Recast alone. I think this has to do with the setAST maneuver. In particular:
     *
     * 1. Leading whitespace will be dropped. (`\n\nf()` ==> `f()`)
     * 2. If the file has a shebang, it'll be combined with the first line.
     *    (`#!/usr/bin/env node\nf()` ==> `#!/usr/bin/env nodef()`)
     *
     * To fix this, we manually trim out the problematic leading parts, do the recast transform, then add them back at
     * the end.
     */
    let fileContentsForRecast = originalFileContents;
    let fileContentsPrefixToReattachPostTransform = '';
    if (originalFileContents.startsWith('#!')) {
      const shebangEndIndex = originalFileContents.indexOf('\n');
      fileContentsForRecast = originalFileContents.slice(shebangEndIndex);
      fileContentsPrefixToReattachPostTransform = originalFileContents.slice(0, shebangEndIndex);

      const leadingWhitespace = /\s+/.exec(fileContentsForRecast);
      if (leadingWhitespace) {
        fileContentsForRecast = fileContentsForRecast.slice(leadingWhitespace[0].length);
        fileContentsPrefixToReattachPostTransform += leadingWhitespace[0];
      }
    }

    // The impact of erroneous changes would be reduced if we detected when the AST is unchanged, and then did not
    // write new file contents. However, this proved difficult to do. Instead, we'll allow the plugin to explicitly say
    // when it changed.

    let pluginWillSignalWhenAstHasChanged = false;
    let pluginChangedAst = false;
    let metaResult;

    let codemodPlugin: PluginItem;
    let useRecast = true;
    try {
      // TODO: Make a way for the codemod to cleanly say that the file should not be modified.
      // Maybe returning undefined?
      //
      // This is sort of accomplished by allowing a codemod to call willNotifyOnAstChange() and never astDidChange().
      const resultOfGetPlugin = await codemod.getPlugin({
        ...codemodOpts,
        willNotifyOnAstChange: () => {
          pluginWillSignalWhenAstHasChanged = true;
        },
        astDidChange: () => {
          pluginChangedAst = true;
        },
        setMetaResult: meta => {
          metaResult = meta;
        }
      });

      if (resultOfGetPlugin && typeof resultOfGetPlugin === 'object' && 'plugin' in resultOfGetPlugin) {
        codemodPlugin = resultOfGetPlugin.plugin;
        if (resultOfGetPlugin.useRecast === false) {
          useRecast = resultOfGetPlugin.useRecast;
        }
      } else {
        codemodPlugin = resultOfGetPlugin;
      }
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

    const getAst = (): ReturnType<typeof recast.parse> | ReturnType<typeof babelParse> => {
      if (useRecast) {
        const parser = {
          parse(source: string, opts: Record<string, unknown>) {
            const babelOpts = {
              ...getBabelOpts(),
              ..._.pick(codemod, 'presets'),
              // There are options that are recognized by recast but not babel. Babel errors when they're passed. To
              // avoid this, we'll omit them.
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

        try {
          return recast.parse(fileContentsForRecast, {parser});
        } catch (e) {
          e.phase = 'recast.parse using the settings you passed';
          e.suggestion = "Check that you passed the right babel preset in the codemod's `presets` field.";
          throw e;
        }
      }

      const babelParseResult = babelParse(originalFileContents, {
        ...getBabelOpts(),
        ..._.pick(codemod, 'presets')
      });

      assert(babelParseResult, 'Bug in jscodemod: expected the result of babel.parse to be truthy.');

      return babelParseResult;
    };

    const pluginsToUse = [codemodPlugin];
    const ast = getAst();

    if (useRecast) {
      const setAst: PluginItem = (): PluginObj => ({
        visitor: {
          Program(path) {
            path.replaceWith(ast.program);
          }
        }
      });
      pluginsToUse.unshift(setAst);
    }

    // result.ast.end will be 0, and ast.end is originalFileContents.length.
    // Passing originalFileContents instead of '' solves that problem, but causes some other problem.
    let babelTransformResult: ReturnType<typeof babelTransformSync>;
    try {
      babelTransformResult = babelTransformSync('', getBabelOpts(pluginsToUse));
    } catch (e) {
      e.phase = "babelTransformSync using the plugin returned by your codemod's getPlugin()";
      e.suggestion = 'Check your babel plugin for runtime errors.';
      throw e;
    }

    log.debug({pluginWillSignalWhenAstHasChanged, pluginChangedAst, useRecast});

    if (!pluginWillSignalWhenAstHasChanged && pluginChangedAst) {
      const err = new Error('Your plugin called astDidChange() but not willNotifyOnAstChange(). ' +
        'This almost definitely means you have a bug.');
      Object.assign(err, {
        phase: 'your codemod babel plugin running',
        suggestion: 'call willNotifyOnAstChange() if you intend to use the astDidChange() API, ' +
          "or remove all calls to astDidChange() if you don't."
      });
      throw err;
    }

    if (pluginWillSignalWhenAstHasChanged && !pluginChangedAst) {
      if (metaResult !== undefined) {
        return {meta: metaResult, code: originalFileContents};
      }
      return originalFileContents;
    }

    if (!babelTransformResult) {
      const err = new Error(`Transforming "${sourceCodeFile}" resulted in a null babel result.`);
      Object.assign(err, {
        phase: 'your codemod babel plugin running',
        suggestion: "Check your plugin for a bug, or ignore this file in your codemod's ignore list."
      });
      throw err;
    }

    let transformedCode = useRecast ?
      fileContentsPrefixToReattachPostTransform + recast.print(babelTransformResult.ast as recast.types.ASTNode).code :
      babelTransformResult.code;

    if (transformedCode && originalFileContents.endsWith('\n') && !transformedCode.endsWith('\n')) {
      transformedCode += '\n';
    }

    if (metaResult !== undefined) {
      return {meta: metaResult, code: transformedCode};
    }

    return transformedCode;
  };

  let codemodResult: PromiseValue<ReturnType<typeof transformFile>> = null;
  let thrownError = null;

  try {
    codemodResult = await log.logPhase({phase: 'transform file', level: 'trace'}, transformFile);
  } catch (e) {
    thrownError = e;
    log.error({
      error: _.pick(e, 'message', 'stack', 'phase')
    }, `File ${sourceCodeFile}: Codemod "${codemodName}" threw an error during ${e.phase}. ${e.suggestion}`);
  }

  const ostensiblyTransformedCode = typeof codemodResult === 'string' ? codemodResult : codemodResult?.code;

  const codeModified = Boolean(ostensiblyTransformedCode) && ostensiblyTransformedCode !== originalFileContents;

  if (codeModified && writeFiles) {
    // This non-null assertion is safe because `codeModified` includes a check on `transformedCode`.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    await pFs.writeFile(sourceCodeFile, ostensiblyTransformedCode!);
  }
  const action = thrownError ? 'error' : codeModified ? 'modified' : 'skipped';
  log.debug({action, writeFiles});

  return {
    action,
    error: thrownError,
    codeModified,
    // if codeModified is true, we know ostensiblyTransformedCode is a string.
    fileContents: codeModified ? (ostensiblyTransformedCode as string) : originalFileContents,
    meta: typeof codemodResult === 'string' ? undefined : codemodResult?.meta,
    filePath: sourceCodeFile
  };
}