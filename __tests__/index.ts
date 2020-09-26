import tempy from 'tempy';
import execa, {ExecaReturnValue} from 'execa';
import path from 'path';
import 'loud-rejection/register';
import createLog from 'nth-log';
import _ from 'lodash';
import globby from 'globby';
import {promises as fs} from 'fs';

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
      for (const file of files) {
        log.debug({file}, 'Read file');
        const fileContents = await fs.readFile(file, 'utf-8');
        
        expect(fileContents).toMatchSnapshot();
      }
    }
    if (assert) {
      await assert(spawnResult, testDir);
    }
  });
  /* eslint-enable jest/no-conditional-expect */
}

describe('happy path', () => {
  createTest({
    fixtureName: 'prepend-string',
    spawnArgs: ['--codemod', path.join('codemod', 'codemod.js'), 'source'],
    snapshot: true
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

