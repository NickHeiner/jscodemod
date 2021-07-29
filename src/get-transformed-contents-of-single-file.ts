import jscodemod, {Options} from '.';
import {CodemodMetaResult} from './run-codemod-on-file';
import getLogger from './get-logger';

async function getTransformedContentsOfSingleFile(
  pathToCodemod: string,
  inputFile: string,
  codemodOptions?: Options
): Promise<string> {
  const codemodMetaResults = await jscodemod(
    pathToCodemod,
    [inputFile],
    {
      respectIgnores: false,
      log: getLogger(),
      ...codemodOptions,
      doPostProcess: false,
      writeFiles: false
    }
  ) as unknown as CodemodMetaResult<unknown>[];

  if (codemodMetaResults[0].action === 'error') {
    throw codemodMetaResults[0].error;
  }

  return codemodMetaResults[0].fileContents;
}

export default getTransformedContentsOfSingleFile;