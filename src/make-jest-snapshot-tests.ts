import jscodemod from '.';
import {Options} from './types';
import {CodemodMetaResult} from './run-codemod-on-file';
import getLogger from './get-logger';
import globby from 'globby';
import _ from 'lodash';
import path from 'path';

// TODO: Add note about whether it's best to use require.resolve for pathToCodemod.

function makeJestSnapshotTests(
  pathToCodemod: string,
  fixtureDir: string,
  suiteName: string,
  codemodOptions?: Options & {debugLogger?: boolean}
): void {
  const inputFiles = globby.sync('**/*.*', {cwd: fixtureDir, absolute: true});

  // TODO Should this share with getTransformedContentsOfSingleFile?

  const opts: Options = {
    ...codemodOptions, 
    inputFiles,
    inputFilePatterns: [],
    alwaysTransform: true,
    writeFiles: false, 
    doPostProcess: false, 
    watch: false
  };
  if (codemodOptions?.debugLogger) {
    opts.log = getLogger();
  }

  describe(suiteName, () => {
    let codemodMetaResults: CodemodMetaResult[];
    beforeAll(async () => {
      codemodMetaResults = await jscodemod(
        pathToCodemod,
        opts
      ) as unknown as CodemodMetaResult[];
    });

    inputFiles.forEach(filePath => {
      it(path.relative(fixtureDir, filePath), () => {
        const codemodMetaResultForThisFile = _.find(codemodMetaResults, {filePath});
  
        if (!codemodMetaResultForThisFile) {
          const allFilePaths = _.map(codemodMetaResults, 'filePath');
          const error = new Error(
            `Bug in @nth/jscodemod: Could not find codemod results for "${filePath}". ` +
            `Codemod results were found for: "${allFilePaths.join('", "')}"`);
          Object.assign(error, {filePath, allFilePaths});
          throw error;
        }

        if (codemodMetaResultForThisFile.debugEntries.length) {
          // We use console to communicate with the user.
          // eslint-disable-next-line no-console
          console.log(codemodMetaResultForThisFile.debugEntries);
        }

        if ('error' in codemodMetaResultForThisFile) {
          throw codemodMetaResultForThisFile.error;
        }

        expect(codemodMetaResultForThisFile.fileContents).toMatchSnapshot();
      });
    });
  });
}

export default makeJestSnapshotTests;