import getLogger from './get-logger';
import piscina from 'piscina';
import loadCodemod from './load-codemod';
import _ from 'lodash';
import runCodemodOnFile, {CodemodMetaResult} from './run-codemod-on-file';

// I wonder if we could measure perf gains by trimming this import list.

const baseLog = getLogger({
  name: 'jscodemod-worker',
  ...piscina.workerData.logOpts
});

/**
 * I don't think we can share this instance across workers – I got an error that said the transform function
 * "could not be cloned" when I tried to pass the codemod itself on `workerData`.
 */
const codemod = loadCodemod(piscina.workerData.codemodPath);

export default function main(
  {inputFile, runStartTimeMs}: {inputFile: string, runStartTimeMs: number}
): Promise<CodemodMetaResult<unknown>> {
  return runCodemodOnFile(
    codemod,
    inputFile,
    baseLog,
    _.pick(piscina.workerData, 'codemodArgs', 'codemodPath'),
    runStartTimeMs
  );
}