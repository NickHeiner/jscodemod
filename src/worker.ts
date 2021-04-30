import createLog from 'nth-log';
import piscina from 'piscina';
import fs from 'fs';
import loadCodemod from './load-codemod';
import type {CodemodResult, DetectLabel} from './types';
import {serializeError} from 'serialize-error';
import _ from 'lodash';

// I wonder if we could measure perf gains by trimming this import list.

const baseLog = createLog({name: 'jscodemod-worker'});

const pFs = fs.promises;

/**
 * I don't think we can share this instance across workers – I got an error that said the transform function 
 * "could not be cloned" when I tried to pass the codemod itself on `workerData`.
 */
const codemod = loadCodemod(piscina.workerData.codemodPath);

export type BaseCodemodMeta = {
  filePath: string;
  fileContents: string;
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

export type DebugMeta = {
  debugEntries: unknown[]
} & BaseCodemodMeta;

export type CodemodMetaResult = TransformMeta | DetectMeta | ErrorMeta | DebugMeta;

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

export default async function main(sourceCodeFile: string): Promise<CodemodMetaResult> {
  const log = baseLog.child({sourceCodeFile});
  log.debug({action: 'start'});

  const originalFileContents = await pFs.readFile(sourceCodeFile, 'utf-8');
  const parsedArgs = await codemod.parseArgs?.(piscina.workerData.codemodArgs);

  const debugEntries: DebugMeta['debugEntries'] = [];
  const debugLog = (entry: unknown) => debugEntries.push(entry);

  const baseMeta = {
    fileContents: originalFileContents,
    filePath: sourceCodeFile
  };

  const labeller = makeLabeller();

  const codemodOpts = {
    source: originalFileContents, 
    filePath: sourceCodeFile, 
    commandLineArgs: parsedArgs,
    debugLog,
    ..._.pick(labeller, 'applyLabel')
  };

  let transformedCode = await codemod.transform(codemodOpts);
  try {
    transformedCode = await codemod.transform(codemodOpts);
  } catch (e) {
    log.debug({e}, 'Codemod threw an error');
    return {
      error: serializeError(e),
      ...baseMeta
    };
  }

  if (debugEntries.length) {
    return {
      debugEntries,
      ...baseMeta
    };
  }

  if (codemod.detect) {
    log.debug({action: 'detect', result: labeller.getLabel()});
    return {
      label: labeller.getLabel(),  
      ...baseMeta
    };
  }

  const codeModified = Boolean(transformedCode && transformedCode !== originalFileContents);
  const {writeFiles} = piscina.workerData; 
  if (codeModified && writeFiles) {
    // I originally had this cast inline but TS didn't recognize it.
    const truthyCodemodResult = transformedCode as CodemodResult;

    // This non-null assertion is safe because `codeModified` includes a check on `transformedCode`.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    await pFs.writeFile(sourceCodeFile, truthyCodemodResult!);
  }
  log.debug({action: codeModified ? 'modified' : 'skipped', writeFiles});

  if (debugEntries.length) {
    return {
      debugEntries,
      ...baseMeta
    };
  }

  return {
    ...baseMeta,
    codeModified, 
    fileContents: transformedCode ? transformedCode : originalFileContents
  };
}