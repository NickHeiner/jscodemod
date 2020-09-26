import tempy from 'tempy';
import execa, {ExecaReturnValue} from 'execa';
import path from 'path';
import cpy from 'cpy';
import 'loud-rejection/register';
import createLog from 'nth-log';
import _ from 'lodash';

const log = createLog({name: 'test'});

type TestArgs = {
  fixtureName: string; 
  testName?: string;
  spawnArgs: string[];
  expectedExitCode?: number;
  assert: (ExecaReturnValue, testDir: string) => void;
}

const packageJson = require('../package');

function test({fixtureName, testName, spawnArgs, expectedExitCode = 0, assert}: TestArgs) {
  it(testName || fixtureName, async () => {
    const testDir = await tempy.directory({prefix: `${packageJson.name}-test-${fixtureName}`});

    const repoRoot = path.resolve(__dirname, '..');
    const fixtureDir = path.resolve(repoRoot, 'fixtures', fixtureName);

    await cpy(fixtureDir, testDir);

    const binPath = path.resolve(repoRoot, packageJson.bin.jscodemod);

    const spawnResult = await execa(binPath, spawnArgs, {cwd: testDir});

    log.debug({
      testDir,
      ..._.pick(spawnResult, 'stdout')
    });

    expect(spawnResult.exitCode).toBe(expectedExitCode);
    await assert(spawnResult, testDir);
  });
}

test({
  fixtureName: 'prepend-string',
  spawnArgs: ['--codemod', 'codemod.js', 'source'],
  assert: (spawnResult, testDir) => {

  }
});

