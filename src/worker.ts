import getLogger from './get-logger';
import piscina from 'piscina';
import loadCodemod from './load-codemod';
import _ from 'lodash';
import runCodemodOnFile, {CodemodMetaResult} from './run-codemod-on-file';

const baseLog = getLogger({
  name: 'jscodemod-worker',
  ...piscina.workerData.logOpts
});

/**
 * I don't think we can share this instance across workers – I got an error that said the transform function
 * "could not be cloned" when I tried to pass the codemod itself on `workerData`.
 */
const codemod = loadCodemod(piscina.workerData.codemodPath);

export default function main(sourceCodeFile: string): Promise<CodemodMetaResult> {
  return runCodemodOnFile(
    codemod,
    sourceCodeFile,
    baseLog,
    _.pick(piscina.workerData, 'codemodArgs', 'writeFiles', 'codemodPath')
  );
}