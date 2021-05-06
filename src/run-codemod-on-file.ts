import type {NTHLogger} from 'nth-log';
import fs from 'fs';
import type {CodemodResult, DetectLabel, Codemod} from './types';
import {serializeError} from 'serialize-error';
import _ from 'lodash';
import {parseSync, transformFromAstSync} from '@babel/core';

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
    if ('presets' in codemod) {
      const parseResult = await perfLog('parseSync', () => parseSync(originalFileContents, {
        filename: sourceCodeFile,
        ast: true,
        ..._.pick(codemod, 'presets')
      }));

      if (!parseResult) {
        throw new Error(
          "Bug in jscodemod: Babel.parseSync returned a falsey parseResult. I don't know when this would happen."
        );
      }

      const plugin = await codemod.getPlugin(codemodOpts);
      transformedCode = transformFromAstSync(parseResult, originalFileContents, {
        plugins: [plugin]
      })?.code;
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

  const codeModified = Boolean(transformedCode && transformedCode !== originalFileContents);
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