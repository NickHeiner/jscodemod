import createLog from 'nth-log';
import piscina from 'piscina';
import fs from 'fs';
import loadCodemod from './load-codemod';
import type {DetectLabel} from './types';
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
  label: DetectLabel;
} & BaseCodemodMeta;

export type ErrorMeta = {
  error: Error
} & BaseCodemodMeta;

export type CodemodMetaResult = TransformMeta | DetectMeta | ErrorMeta;

const makeLabeller = () => {
  let currentLabel: string, currentLabelPriority = -Infinity;

  function applyLabel(priority: number, label: string) {
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

  const codemodOpts = {
    source: originalFileContents, 
    filePath: sourceCodeFile, 
    commandLineArgs: parsedArgs
  };

  // TODO: Handle the codemod throwing an error?
  if ('transform' in codemod) {
    const transformedCode = await codemod.transform(codemodOpts);
    const codeModified = Boolean(transformedCode && transformedCode !== originalFileContents);
    const {writeFiles} = piscina.workerData; 
    if (codeModified && writeFiles) {
      // This non-null assertion is safe because `codeModified` includes a check on `transformedCode`.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      await pFs.writeFile(sourceCodeFile, transformedCode!);
    }
    log.debug({action: codeModified ? 'modified' : 'skipped', writeFiles});

    return {
      codeModified, 
      fileContents: transformedCode ? transformedCode : originalFileContents,
      filePath: sourceCodeFile
    };
  }
  const labeller = makeLabeller();

  try {
    await codemod.detect({...codemodOpts, ..._.pick(labeller, 'applyLabel')});
  } catch (e) {
    log.debug({e}, 'Codemod threw an error');
    return {
      error: serializeError(e),
      fileContents: originalFileContents,
      filePath: sourceCodeFile
    };
  }

  log.debug({action: 'detect', result: labeller.getLabel()});

  return {
    label: labeller.getLabel(),  
    fileContents: originalFileContents,
    filePath: sourceCodeFile
  };
}