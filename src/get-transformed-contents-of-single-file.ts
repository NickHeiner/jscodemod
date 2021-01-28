import jscodemod, {Options} from '.';
import {CodemodMetaResult} from './worker';

/**
 * @public
 */
async function getTransformedContentsOfSingleFile(
  pathToCodemod: string,
  inputFile: string,
  codemodOptions?: Options
): Promise<string> {
  const codemodMetaResults = await jscodemod(
    pathToCodemod,
    [inputFile],
    {...codemodOptions, writeFiles: false, doPostProcess: false}
  ) as unknown as CodemodMetaResult[];

  return codemodMetaResults[0].fileContents;
}

export default getTransformedContentsOfSingleFile;