import jscodemod from '.';
import {Options} from './types';
import {CodemodMetaResult} from './run-codemod-on-file';
import getLogger from './get-logger';

// TODO: make sure this works when codemod has detect: true.

async function getTransformedContentsOfSingleFile(
  pathToCodemod: string,
  inputFile: string,
  codemodOptions?: Options & {debugLogger?: boolean}
): Promise<string> {
  const opts: Options = {
    alwaysTransform: true,
    ...codemodOptions, 
    inputFiles: [inputFile],
    inputFilePatterns: [],
    writeFiles: false, 
    doPostProcess: false, 
    watch: false
  };
  if (codemodOptions?.debugLogger) {
    opts.log = getLogger();
  }

  const codemodMetaResults = await jscodemod(
    pathToCodemod,
    opts
  ) as unknown as CodemodMetaResult[];

  if ('error' in codemodMetaResults[0]) {
    throw codemodMetaResults[0].error;
  }

  return codemodMetaResults[0].fileContents;
}

export default getTransformedContentsOfSingleFile;