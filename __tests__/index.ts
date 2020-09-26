import tempy from 'tempy';
import execa, {ExecaReturnValue} from 'execa';
import path from 'path';
import cpy from 'cpy';
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
}

const packageJson = require('../package');

function spawnTest({fixtureName, testName, spawnArgs, expectedExitCode = 0, snapshot, assert}: TestArgs) {
  it(testName || fixtureName, async () => {
    const testDir = await tempy.directory({prefix: `${packageJson.name}-test-${fixtureName}`});

    const repoRoot = path.resolve(__dirname, '..');
    const fixtureDir = path.resolve(repoRoot, 'fixtures', fixtureName);

    await execa('cp', ['-r', fixtureDir + path.sep, testDir]);
    // await cpy(fixtureDir, testDir, {
    //   parents: true, 
    //   rename: basename => path.relative(repoRoot, basename)
    // });

    const binPath = path.resolve(repoRoot, packageJson.bin.jscodemod);

    let spawnResult;
    try {
      spawnResult = await execa(binPath, spawnArgs, {cwd: testDir});
    } catch (error) {
      spawnResult = error;
    }

    log.debug({
      testDir,
      ..._.pick(spawnResult, 'stdout')
    });

    expect(spawnResult.exitCode).toBe(expectedExitCode);
    if (snapshot) {
      const files = await globby(testDir);
      for (const file of files) {
        const fileContents = await fs.readFile(file, 'utf-8');
        expect(fileContents).toMatchSnapshot();
      }
    }
    if (assert) {
      await assert(spawnResult, testDir);
    }
  });
}

spawnTest({
  fixtureName: 'prepend-string',
  spawnArgs: ['--codemod', path.join('codemod', 'codemod.js'), 'source'],
  snapshot: true
});

