import jscodemod, { Options } from '.';
import { CodemodMetaResult } from './run-codemod-on-file';
import getLogger from './get-logger';
import _ from 'lodash';

/**
 * Run a codemod on a single file and return the result. Does not modify anything on disk.
 *
 * This function does not respect ignores. If you have a codemod that ignores the file pattern `__fixtures__`, then you
 * call this function with a file in __fixtures__, this function will transform that file.
 *
 * This function will not call your codemod's postProcess() hook, if it exists.
 *
 * @param pathToCodemod An absolute path to your codemod.
 * @param inputFile An absolute path to the file to transform.
 * @param codemodOptions Options to pass through to jscodemod.
 * @returns The string contents of the transformed file. If the codemod at `pathToCodemod` throws an error,
 *  this function will bubble up that error.
 */
async function getTransformedContentsOfSingleFile(
  pathToCodemod: string,
  inputFile: string,
  codemodOptions?: Options
): Promise<string> {
  const codemodMetaResults = (await jscodemod(pathToCodemod, {
    respectIgnores: false,
    log: getLogger(),
    ..._.omit(codemodOptions, 'inputFileList'),
    inputFilesPatterns: [inputFile],
    doPostProcess: false,
    writeFiles: false,
  })) as unknown as CodemodMetaResult<unknown>[];

  if (codemodMetaResults[0].action === 'error') {
    throw codemodMetaResults[0].error;
  }

  return codemodMetaResults[0].fileContents;
}

export default getTransformedContentsOfSingleFile;
