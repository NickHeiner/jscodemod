import tempy from 'tempy';
import execa, {ExecaReturnValue} from 'execa';
import path from 'path';
import 'loud-rejection/register';
import createLog from 'nth-log';
import _ from 'lodash';
import globby from 'globby';
import {promises as fs} from 'fs';
import parseJson from 'parse-json';

const log = createLog({name: 'test'});

type TestArgs = {
  fixtureName: string; 
  testName?: string;
  spawnArgs: string[];
  expectedExitCode?: number;
  snapshot?: boolean;
  assert?: (ExecaReturnValue, testDir: string) => void;
  modifier?: 'only' | 'skip';
}

// I don't think we can import JSON via ESM.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const packageJson = require('../package');

function createTest({fixtureName, testName, spawnArgs, expectedExitCode = 0, snapshot, assert, modifier}: TestArgs) {
  // This is part of our dynamic testing approach.
  /* eslint-disable jest/no-conditional-expect */
  /* eslint-disable jest/no-standalone-expect */

  const testMethod = modifier ? it[modifier] : it;
  testMethod(testName || fixtureName, async () => {
    const testDir = await tempy.directory({prefix: `${packageJson.name}-test-${fixtureName}`});
    log.debug({testDir});

    const repoRoot = path.resolve(__dirname, '..');
    const fixtureDir = path.resolve(repoRoot, 'fixtures', fixtureName);

    await execa('cp', ['-r', fixtureDir + path.sep, testDir]);
    await execa('yarn', {cwd: testDir});
    await execa('ln', ['-s', repoRoot, path.join('node_modules', packageJson.name)], {cwd: testDir});

    const binPath = path.resolve(repoRoot, packageJson.bin.jscodemod);

    let spawnResult;
    try {
      spawnResult = await log.logPhase(
        {phase: 'spawn codemod', level: 'debug'}, 
        () => execa(binPath, spawnArgs, {cwd: testDir})
      );
    } catch (error) {
      spawnResult = error;
    }

    const logMethodToUse = spawnResult.exitCode === expectedExitCode ? 'debug' : 'fatal';
    log[logMethodToUse]({
      testDir,
      ..._.pick(spawnResult, 'stdout')
    });

    expect(spawnResult.exitCode).toBe(expectedExitCode);
    if (snapshot) {
      const files = await log.logPhase(
        {phase: 'snapshot glob', level: 'debug'}, 
        async (_logProgress, setAdditionalLogData) => {
          // We'll consider codemods that modify `package.json` or these other config files to be out of scope.
          const files = await globby(
            ['**/*', '!node_modules', '!yarn.lock', '!package.json', '!tsconfig.json'], 
            {cwd: testDir}
          );
          setAdditionalLogData({foundFileCount: files.length});
          return files.map(file => path.join(testDir, file));
        }
      );
      const fileContents = Object.fromEntries(
        await Promise.all(files.map(async file => {
          log.debug({file}, 'Read file');
          return [path.relative(testDir, file), await fs.readFile(file, 'utf-8')];
        }))
      );
      expect(fileContents).toMatchSnapshot();
    }
    if (assert) {
      await assert(spawnResult, testDir);
    }
  });
  /* eslint-enable jest/no-conditional-expect */
}

const sanitizeLogLine = (logEntry: Record<string, unknown>) => 
  _.omit(logEntry, ['name', 'hostname', 'pid', 'time', 'v']);

const getJsonLogs = (stdout: string) => stdout.split('\n').map(line => sanitizeLogLine(parseJson(line)));

describe('happy path', () => {
  createTest({
    fixtureName: 'prepend-string',
    spawnArgs: ['--codemod', path.join('codemod', 'codemod.js'), 'source'],
    snapshot: true
  });
  createTest({
    testName: 'dry',
    fixtureName: 'prepend-string',
    spawnArgs: ['--dry', '--json-output', '--codemod', path.join('codemod', 'codemod.js'), 'source'],
    snapshot: true,
    assert(spawnResult, testDir) {
      const jsonLogs = getJsonLogs(spawnResult.stdout);
      const [inputFilesLogLine, otherLogLines] = _.partition(jsonLogs, 'inputFiles');
      expect(otherLogLines).toMatchSnapshot();

      const relativeInputFiles = new Set(
        (inputFilesLogLine[0].inputFiles as string[]).map(inputFile => path.relative(testDir, inputFile))
      );
      expect(relativeInputFiles).toEqual(new Set(['source/a.js', 'source/b.js']));
    }
  });
  createTest({
    fixtureName: 'arrow-function-inline-return',
    spawnArgs: ['--codemod', path.join('codemod', 'index.ts'), 'source', '*.ts'],
    snapshot: true
  });
});

describe('error handling', () => {
  createTest({
    testName: 'missing pattern of files to transform',
    fixtureName: 'prepend-string',
    spawnArgs: ['--codemod', path.join('codemod', 'codemod.js')],
    expectedExitCode: 1
  });

  createTest({
    testName: 'missing path to codemod',
    fixtureName: 'prepend-string',
    spawnArgs: ['source'],
    expectedExitCode: 1
  });
});

