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
import {getTransformedContentsOfSingleFile} from '../build';

const log = createLog({name: 'test'});

type TestArgs = {
  fixtureName: string; 
  testName?: string;
  spawnArgs: string[];
  expectedExitCode?: number;
  git?: boolean;
  snapshot?: true; 
  setUpNodeModules?: boolean;
  assert?: (ExecaReturnValue, testDir: string, getRelativeFilePaths: (inputFilePaths: string[]) => string[]) => void;
  modifier?: 'only' | 'skip';
}

// I don't think we can import JSON via ESM.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const packageJson = require('../package');

const replaceAll = (string: string, pattern: string | RegExp, replacement: string) => {
  const newString = string.replace(pattern, replacement);
  return newString === string ? string : replaceAll(newString, pattern, replacement);
};

function createTest({
  fixtureName, testName, spawnArgs, expectedExitCode = 0, snapshot, git, setUpNodeModules = true, assert, modifier
}: TestArgs) {
  // This is part of our dynamic testing approach.
  /* eslint-disable jest/no-conditional-expect */
  /* eslint-disable jest/no-standalone-expect */

  const testMethod = modifier ? it[modifier] : it;
  const testNameWithDefault = testName || fixtureName;
  testMethod(testNameWithDefault, async () => {
    const testDirSuffix = replaceAll(sanitizeFilename(testNameWithDefault), ' ', '-').toLowerCase();
    const testDirPrefix = `${packageJson.name.replace('/', '-')}-test-${testDirSuffix}`;
    const testDir = await tempy.directory({prefix: testDirPrefix});
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
      const symlinkLocation = path.join('node_modules', packageJson.name);
      await execa('mkdir', ['-p', path.dirname(symlinkLocation)], {cwd: testDir});
      await execa('ln', ['-s', repoRoot, symlinkLocation], {cwd: testDir});
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
          const globPatterns = ['**/*', '!yarn.lock', '!package.json', '!tsconfig.json', '!node_modules'];
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
      const getRelativeFilePaths = 
        (inputFilePaths: string[]) => inputFilePaths.map(filePath => path.relative(testDir, filePath));
      await assert(spawnResult, testDir, getRelativeFilePaths);
    }
  });
  /* eslint-enable jest/no-conditional-expect */
}

const sanitizeLogLine = (logEntry: {msg: string} & Record<string, unknown>) => ({
  ..._.omit(logEntry, ['name', 'hostname', 'pid', 'time', 'v'])
});

const getJsonLogs = (stdout: string) => stdout.split('\n').map(line => {
  let parsedLine;
  try {
    parsedLine = parseJson(line);
  } catch (e) {
    log.error({line}, 'Could not parse line');
    throw e;
  }
  const logLine = sanitizeLogLine(parsedLine);
  if (logLine.msg) {
    logLine.msg = stripAnsi(logLine.msg as string);
  }
  return logLine;
});

// I don't think extracting this to a var would help readability.
// eslint-disable-next-line no-magic-numbers
jest.setTimeout(15 * 1000);

describe('happy path', () => {
  createTest({
    fixtureName: 'prepend-string',
    spawnArgs: ['--codemod', path.join('codemod', 'codemod.js'), '--codemodArgs', 'a b c', '.', '!codemod'],
    setUpNodeModules: false,
    snapshot: true,
    assert(spawnResult, testDir) {
      const sanitizedStdout = stripAnsi(replaceAll(spawnResult.stdout, testDir, '<test-dir>'));
      const findLine = substring => sanitizedStdout.split('\n').find(line => line.includes(substring));

      const postProcessOutput = findLine('codemod post process');
      expect(postProcessOutput).toBeTruthy();
      expect(postProcessOutput).toMatchSnapshot();

      const commandLineArgs = findLine('commandLineArgs');
      expect(commandLineArgs).toBeTruthy();
      expect(commandLineArgs).toMatchSnapshot();
    }
  });
  createTest({
    testName: 'dry',
    fixtureName: 'prepend-string',
    spawnArgs: ['--dry', '--json-output', '--codemod', path.join('codemod', 'codemod.js'), 'source'],
    snapshot: true,
    assert(spawnResult, testDir, getRelativeFilePaths) {
      const jsonLogs = getJsonLogs(spawnResult.stdout);
      const inputFilesLogLine = _.find(jsonLogs, 'filesToModify');

      const inputFiles = ((inputFilesLogLine as Record<string, unknown>).filesToModify as string[]);
      const relativeInputFiles = new Set(getRelativeFilePaths(inputFiles));
      expect(relativeInputFiles).toEqual(
        new Set(['source/.dotfile.js', 'source/a.js', 'source/b.js', 'source/blank.js'])
      );
    }
  });
  createTest({
    testName: 'dry porcelain',
    fixtureName: 'prepend-string',
    spawnArgs: ['--dry', '--porcelain', '--codemod', path.join('codemod', 'codemod.js'), 'source'],
    snapshot: true,
    assert(spawnResult, testDir) {
      const sanitizedStdout = replaceAll(spawnResult.stdout, testDir, '<test-dir>');
      expect(sanitizedStdout).toMatchSnapshot();
    }
  });
  createTest({
    modifier: 'only',
    testName: 'TS without manually specifying any of the args determining how to compile',
    fixtureName: 'arrow-function-inline-return',
    spawnArgs: ['--codemod', path.join('codemod', 'index.ts'), 'source'],
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

  createTest({
    testName: 'missing required argument to codemod',
    fixtureName: 'parse-args',
    spawnArgs: ['--codemod', path.join('codemod', 'index.ts'), '*.js'],
    expectedExitCode: 1,
    assert({stderr}) {
      expect(stderr).toMatchSnapshot();
    }
  });

  const createTestForThrowingError = (codemodName: string, codemodFileName: string) => 
    createTest({
      testName: `handles codemod ${codemodName} (${codemodFileName}) throwing an error`,
      fixtureName: 'will-throw-error',
      spawnArgs: ['--codemod', path.join('codemod', codemodFileName), 'source', '--json-output'],
      snapshot: true,
      assert(spawnResult) {
        const jsonLogs = getJsonLogs(spawnResult.stdout);

        expect(jsonLogs).toContainEqual(expect.objectContaining({
          msg: `Codemod "${codemodName}" threw an error for a file.`,
          error: expect.objectContaining({
            stack: expect.any(String),
            // I tried to use a regex matcher here but I couldn't get it to work.
            message: expect.stringContaining('source/a.js')
          })
        }));
        expect(jsonLogs).toContainEqual(expect.objectContaining({
          msg: `Codemod "${codemodName}" threw an error for a file.`,
          error: expect.objectContaining({
            stack: expect.any(String),
            message: expect.stringContaining('source/b.js')
          })
        }));
      }
    });

  createTestForThrowingError('codemod-unnamed.js', 'codemod-unnamed.js');
  createTestForThrowingError('my-codemod-name', 'codemod-named.js');
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
      '--jsonOutput',
      'source'
    ],
    snapshot: true,
    assert(spawnResult, testDir, getRelativeFilePaths) {
      const jsonLogs = getJsonLogs(spawnResult.stdout);
      const modifiedFileLog = _.find(jsonLogs, 'modifiedFiles');
      expect(modifiedFileLog).toBeTruthy();
      const modifiedFiles = new Set(getRelativeFilePaths(modifiedFileLog.modifiedFiles as string[]));
      expect(modifiedFiles).toMatchInlineSnapshot(`
Set {
  "source/.gitignore",
  "source/dirty.js",
  "source/unmodified.js",
}
`);
    }
  });
  createTest({
    testName: 'Modify dirty files',
    fixtureName: 'git-dirty',
    git: true,
    spawnArgs: ['--codemod', path.join('codemod', 'codemod.js'), 'source'],
    snapshot: true
  });
});

describe('ignore files', () => {
  createTest({
    testName: 'happy path',
    fixtureName: 'ignorefiles',
    spawnArgs: ['--codemod', 'codemod.js', '**/*.txt'],
    snapshot: true
  });

  createTest({
    testName: 'missing ignore file',
    fixtureName: 'ignorefiles',
    spawnArgs: ['--codemod', 'codemod-missing-ignore-file.js', '**/*.txt', '--json-output'],
    expectedExitCode: 1,
    assert(spawnResult) {
      const jsonLogs = getJsonLogs(spawnResult.stdout);
      expect(jsonLogs).toContainEqual(expect.objectContaining({
        msg: 'Ignore file "does-not-exist.ignore" does not exist.'
      }));
    }
  });
});

describe('getTransformedContentsOfSingleFile', () => {
  const log = createLog({name: 'test'});
  it('returns the contents of a single file', async () => {
    /* eslint-disable no-console */
    console.log = jest.fn().mockImplementation(console.log.bind(console));

    const inputFilePath = path.resolve(__dirname, '../fixtures/prepend-string/source/b.js');
    const originalFilesContents = await fs.readFile(inputFilePath, 'utf-8');
    expect(await getTransformedContentsOfSingleFile(
      require.resolve('../fixtures/prepend-string/codemod/codemod.js'),

      // If we use require.resolve here, then Jest will detect it as a test dependency. When the codemod modifies the
      // file, and we're in watch mode, Jest will kick off another run, continuing ad infinitum.
      inputFilePath,
      {log}
    )).toMatchSnapshot();
    expect(originalFilesContents).toEqual(
      await fs.readFile(inputFilePath, 'utf-8') 
    );

    // @ts-ignore
    const codemodCall = _.find(console.log.mock.calls, {0: 'codemod post process'});
    expect(codemodCall).toBeFalsy();
    
    // @ts-ignore
    console.log.mockReset();

    /* eslint-enable no-console */
  });
});