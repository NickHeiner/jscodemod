import createLog from 'nth-log';
import piscina from 'piscina';
import loadCodemod from './load-codemod';
import _ from 'lodash';
import runCodemodOnFile, { CodemodMetaResult } from './run-codemod-on-file';

// I wonder if we could measure perf gains by trimming this import list.

const baseLog = createLog({name: 'jscodemod-worker'});

/**
 * I don't think we can share this instance across workers – I got an error that said the transform function 
 * "could not be cloned" when I tried to pass the codemod itself on `workerData`.
 */
const codemod = loadCodemod(piscina.workerData.codemodPath);

export default function main(sourceCodeFile: string): Promise<CodemodMetaResult> {
  return runCodemodOnFile(
    codemod, sourceCodeFile, baseLog, _.pick(piscina.workerData, 'codemodArgs', 'writeFiles', 'alwaysTransform')
  );
}