import tempy from 'tempy';
import execa, {ExecaReturnValue} from 'execa';
import path from 'path';
import 'loud-rejection/register';
import createLog from 'nth-log';
import _ from 'lodash';
import globby from 'globby';
import {promises as fs} from 'fs';
import parseJson from 'parse-json';
import stripAnsi from 'strip-ansi';
import resolveBin from 'resolve-bin';
import sanitizeFilename from 'sanitize-filename';

const log = createLog({name: 'test'});

type TestArgs = {
  fixtureName: string; 
  testName?: string;
  spawnArgs: string[];
  expectedExitCode?: number;
  git?: boolean;
  snapshot?: true; 
  setUpNodeModules?: boolean;
  ignoreNodeModulesForSnapshot?: boolean;
  assert?: (ExecaReturnValue, testDir: string) => void;
  modifier?: 'only' | 'skip';
}

// I don't think we can import JSON via ESM.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const packageJson = require('../package');

const replaceAll = (string: string, pattern: string | RegExp, replacement: string) => {
  const newString = string.replace(pattern, replacement);
  return newString === string ? string : replaceAll(newString, pattern, replacement);
}

function createTest({
  fixtureName, testName, spawnArgs, expectedExitCode = 0, snapshot, git,
  setUpNodeModules = true, ignoreNodeModulesForSnapshot = true, 
  assert, modifier
}: TestArgs) {
  // This is part of our dynamic testing approach.
  /* eslint-disable jest/no-conditional-expect */
  /* eslint-disable jest/no-standalone-expect */

  const testMethod = modifier ? it[modifier] : it;
  const testNameWithDefault = testName || fixtureName;
  testMethod(testNameWithDefault, async () => {
    const testDirSuffix = replaceAll(sanitizeFilename(testNameWithDefault), ' ', '-').toLowerCase();
    const testDir = await tempy.directory({prefix: `${packageJson.name}-test-${testDirSuffix}`});
    log.debug({testDir});

    const repoRoot = path.resolve(__dirname, '..');
    const fixtureDir = path.resolve(repoRoot, 'fixtures', fixtureName);

    await execa('cp', ['-r', fixtureDir + path.sep, testDir]);

    if (git) {
      await execa('mv', ['git', '.git'], {cwd: testDir});
      const gitignores = await globby('**/gitignore', {cwd: testDir});
      await Promise.all(gitignores.map(gitignorePath => {
        const dirname = path.dirname(gitignorePath);
        return execa('mv', [gitignorePath, path.join(dirname, '.gitignore')], {cwd: testDir});
      }));
    }

    if (setUpNodeModules) {
      await execa('yarn', {cwd: testDir});
      await execa('ln', ['-s', repoRoot, path.join('node_modules', packageJson.name)], {cwd: testDir});
    }
    
    const binPath = path.resolve(repoRoot, packageJson.bin);

    let spawnResult;
    try {
      spawnResult = await log.logPhase(
        {phase: 'spawn codemod', level: 'debug', binPath, spawnArgs}, 
        () => execa(binPath, spawnArgs, {cwd: testDir})
      );
    } catch (error) {
      spawnResult = error;
    }

    const logMethodToUse = spawnResult.exitCode === expectedExitCode ? 'debug' : 'fatal';
    log[logMethodToUse]({
      testDir,
      ..._.pick(spawnResult, 'stdout', 'stderr', 'exitCode')
    });

    expect(spawnResult.exitCode).toBe(expectedExitCode);
    if (snapshot) {
      const files = await log.logPhase(
        {phase: 'snapshot glob', level: 'debug'}, 
        async (_logProgress, setAdditionalLogData) => {
          // We'll consider codemods that modify `package.json` or these other config files to be out of scope.
          const globPatterns = ['**/*', '!yarn.lock', '!package.json', '!tsconfig.json'];
          if (ignoreNodeModulesForSnapshot) {
            globPatterns.push('!node_modules');
          }
          const files = await globby(
            globPatterns, 
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

const sanitizeLogLine = (logEntry: {msg: string} & Record<string, unknown>) => ({
  ..._.omit(logEntry, ['name', 'hostname', 'pid', 'time', 'v']),
  msg: stripAnsi(logEntry.msg)
});

const getJsonLogs = (stdout: string) => stdout.split('\n').map(line => sanitizeLogLine(parseJson(line)));

describe('happy path', () => {
  createTest({
    fixtureName: 'prepend-string',
    spawnArgs: ['--codemod', path.join('codemod', 'codemod.js'), '.', '!codemod'],
    setUpNodeModules: false,
    ignoreNodeModulesForSnapshot: false,
    snapshot: true
  });
  createTest({
    testName: 'Transform node_modules',
    fixtureName: 'prepend-string',
    setUpNodeModules: false,
    spawnArgs: [
      '--codemod', path.join('codemod', 'codemod.js'), 
      '--ignore-node-modules', 'false', 
      '**/*.js', '!codemod'
    ],
    snapshot: true,
    ignoreNodeModulesForSnapshot: false
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

      const inputFiles = ((inputFilesLogLine[0] as Record<string, unknown>).inputFiles as string[]);
      const relativeInputFiles = new Set(inputFiles.map(inputFile => path.relative(testDir, inputFile)));
      expect(relativeInputFiles).toEqual(new Set(['source/a.js', 'source/b.js', 'source/blank.js']));
    }
  });
  createTest({
    testName: 'TS without manually specifying any of the args determining how to compile',
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

describe('TS compilation flags', () => {
  createTest({
    testName: 'Path to TSC is not specified, and no TSC can be found.',
    fixtureName: 'no-tsc',
    spawnArgs: ['--codemod', path.join('codemod', 'index.ts'), '--json-output', 'input.js'],
    expectedExitCode: 1,
    assert(spawnResult) {
      const jsonLogs = getJsonLogs(spawnResult.stdout);
      expect(jsonLogs).toContainEqual(expect.objectContaining({
        // It's more ergonomic to have this be a single string literal.
        // eslint-disable-next-line max-len
        msg: "If you have a TypeScript codemod, and you don't specify a path to a 'tsc' executable that will compile your codemod, then this tool searches in your codemod's node_modules. However, TypeScript could not be found there either."
      }));
    }
  });

  const localTSC = resolveBin.sync('typescript', {executable: 'tsc'});
  createTest({
    testName: 'Path to TSC is specified',
    fixtureName: 'no-tsc',
    spawnArgs: ['--codemod', path.join('codemod', 'index.ts'), '--tsc', localTSC, 'input.js'],
    snapshot: true
  });

  createTest({
    testName: 'Path to tsconfig is not specified, and no tsconfig can be found.',
    fixtureName: 'tsconfig-non-standard-location',
    spawnArgs: ['--codemod', path.join('codemod', 'index.ts'), '--json-output', 'input.js'],
    expectedExitCode: 1,
    assert(spawnResult) {
      const jsonLogs = getJsonLogs(spawnResult.stdout);
      expect(jsonLogs).toContainEqual(expect.objectContaining({
        // It's more ergonomic to have this be a single string literal.
        // eslint-disable-next-line max-len
        msg: 'This tool was not able to find a tsconfig.json file by doing a find-up from codemod. Please manually specify a tsconfig file path.'
      }));
    }
  });

  createTest({
    testName: 'Specified tsconfig path',
    fixtureName: 'tsconfig-non-standard-location',
    spawnArgs: [
      '--codemod', path.join('codemod', 'index.ts'), 
      '--tsconfig', path.join('configs', 'tsconfig.json'), 
      'input.js'
    ],
    snapshot: true
  });
});

describe('git', () => {
  createTest({
    testName: 'Reset dirty files',
    fixtureName: 'git-dirty',
    git: true,
    spawnArgs: [
      '--codemod', path.join('codemod', 'codemod.js'), 
      '--reset-dirty-input-files',
      'source'
    ],
    snapshot: true
  });
  createTest({
    testName: 'Modify dirty files',
    fixtureName: 'git-dirty',
    git: true,
    spawnArgs: ['--codemod', path.join('codemod', 'codemod.js'), 'source'],
    snapshot: true
  });
});

