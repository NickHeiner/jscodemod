import tempy from 'tempy';
import execa from 'execa';
// This is a false positive – I don't think we can combine a type and value import into one statement.
// eslint-disable-next-line no-duplicate-imports
import type { ExecaReturnValue } from 'execa';
import path from 'path';
import 'loud-rejection/register';
import createLog, { constantizeLogEntryForTest as nthLogConstantizeLogEntryForTest } from 'nth-log';
import _ from 'lodash';
import globby from 'globby';
import { promises as fs } from 'fs';
import parseJson from 'parse-json';
import stripAnsi from 'strip-ansi';
import resolveBin from 'resolve-bin';
import sanitizeFilename from 'sanitize-filename';
import { getTransformedContentsOfSingleFile, execBigCommand } from '../build';
import gitRoot from 'git-root';
import ncp from 'ncp';
import { promisify } from 'util';

const log = createLog({ name: 'test' });

// Tests run slower on GH CI, so I want to increase the timeout. But it's not obvious that this value is being
// respected.
// Disable this lint rule because it's obvious what the number refers to.
// eslint-disable-next-line no-magic-numbers
jest.setTimeout(120 * 1000);

type TestArgs = {
  fixtureName: string;
  testName?: string;
  spawnArgs: string[];
  processOverrides?: typeof process.env;
  expectedExitCode?: number;
  git?: boolean;
  snapshot?: true;
  setUpNodeModules?: boolean;
  assert?: (
    spawnResult: ExecaReturnValue,
    testDir: string,
    getRelativeFilePaths: (inputFilePaths: string[]) => string[]
  ) => void;
  modifier?: 'only' | 'skip';
  getCodemodCwd?: (testDir: string) => string;
};

// I don't think we can import JSON via ESM.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const packageJson = require('../package');

const replaceAll = (string: string, pattern: string | RegExp, replacement: string) => {
  const newString = string.replace(pattern, replacement);
  return newString === string ? string : replaceAll(newString, pattern, replacement);
};

function createTest({
  fixtureName,
  testName,
  spawnArgs,
  expectedExitCode = 0,
  snapshot,
  git,
  setUpNodeModules = true,
  assert,
  modifier,
  processOverrides = process.env,
  getCodemodCwd = (testDir: string) => testDir,
}: TestArgs) {
  // This is part of our dynamic testing approach.
  /* eslint-disable jest/no-conditional-expect */
  /* eslint-disable jest/no-standalone-expect */

  const testMethod = modifier ? it[modifier] : it;
  const testNameWithDefault = testName || fixtureName;
  testMethod(testNameWithDefault, async () => {
    const testDirSuffix = replaceAll(sanitizeFilename(testNameWithDefault), ' ', '-').toLowerCase();
    const testDirPrefix = `${packageJson.name.replace('/', '-')}-test-${testDirSuffix}`;
    const testDir = await tempy.directory({ prefix: testDirPrefix });

    const repoRoot = path.resolve(__dirname, '..');
    const fixtureDir = path.resolve(repoRoot, 'fixtures', fixtureName);

    log.debug({ testDir, fixtureDir }, 'Copy fixture files into test dir');
    await promisify(ncp)(fixtureDir, testDir);

    if (git) {
      await fs.rename(path.join(testDir, 'git'), path.join(testDir, '.git'));
      const gitignores = await globby('**/gitignore', { cwd: testDir });
      await Promise.all(
        gitignores.map(async gitignorePath => {
          const dirname = path.dirname(gitignorePath);
          await fs.rename(
            path.join(testDir, gitignorePath),
            path.join(testDir, dirname, '.gitignore')
          );
        })
      );
    }

    if (setUpNodeModules) {
      await execa('yarn', { cwd: testDir });
      const symlinkLocation = path.join('node_modules', packageJson.name);
      await fs.mkdir(path.resolve(testDir, path.dirname(symlinkLocation)), { recursive: true });
      await execa('ln', ['-s', repoRoot, symlinkLocation], { cwd: testDir });
    }

    const binPath = path.resolve(repoRoot, packageJson.bin);

    let spawnResult;
    try {
      const codemodSpawnCwd = getCodemodCwd(testDir);
      spawnResult = await log.logPhase(
        { phase: 'spawn codemod', level: 'debug', binPath, spawnArgs, codemodSpawnCwd },
        () => execa(binPath, spawnArgs, { cwd: codemodSpawnCwd, env: processOverrides })
      );
    } catch (error) {
      /**
       * TODO: there are some circumstances, like spawn resulting in EACCESS, where we actually do want to throw.
       * In that case, the test is broken.
       */
      spawnResult = error;
    }

    const logMethodToUse = spawnResult.exitCode === expectedExitCode ? 'debug' : 'fatal';
    log[logMethodToUse]({
      testDir,
      ..._.pick(spawnResult, 'stdout', 'stderr', 'exitCode'),
    });

    expect(spawnResult.exitCode).toBe(expectedExitCode);
    if (snapshot) {
      const files = await log.logPhase(
        { phase: 'snapshot glob', level: 'debug' },
        async (_logProgress, setAdditionalLogData) => {
          // We'll consider codemods that modify `package.json` or these other config files to be out of scope.
          const globPatterns = [
            '**/*',
            '!yarn.lock',
            '!package.json',
            '!tsconfig.json',
            '!node_modules',
          ];
          const files = await globby(globPatterns, { cwd: testDir });
          setAdditionalLogData({ foundFileCount: files.length });
          return files.map(file => path.join(testDir, file));
        }
      );
      const fileContents = Object.fromEntries(
        await Promise.all(
          files.map(async file => {
            log.debug({ file }, 'Read file');
            return [path.relative(testDir, file), await fs.readFile(file, 'utf-8')];
          })
        )
      );
      expect(fileContents).toMatchSnapshot();
    }
    if (assert) {
      const getRelativeFilePaths = (inputFilePaths: string[]) =>
        inputFilePaths.map(filePath => path.relative(testDir, filePath));
      await assert(spawnResult, testDir, getRelativeFilePaths);
    }
  });
  /* eslint-enable jest/no-conditional-expect */
}

/**
 * nth-log exports a function to constantize log entries that are dynamic, like the hostname and process ID.
 * jscodemod adds some dynamic fields of its own, so we'll need custom logic to constantize those as well.
 *
 * Mutates `logEntry`.
 */
const constantizeLogEntryForTest = logEntry => {
  const makePlaceholder = (key, placeholder = undefined) => {
    if (key in logEntry) {
      logEntry[key] = placeholder || `<placeholder ${key}>`;
    }
  };

  makePlaceholder('durationMsPretty');
  // eslint-disable-next-line no-magic-numbers
  makePlaceholder('timeSinceRunStart', 123);
  makePlaceholder('timeSinceRunStartPretty');

  if (logEntry.durationMsPretty) {
    logEntry.durationMsPretty = '<placeholder pretty ms duration>';
  }
  return nthLogConstantizeLogEntryForTest(logEntry);
};

const getJsonLogs = (stdout: string) =>
  stdout.split('\n').map((line, index, allLines) => {
    let parsedLine;
    try {
      parsedLine = parseJson(line);
    } catch (e) {
      log.error({ line, allLines }, 'Could not parse line');
      throw e;
    }
    const logLine = constantizeLogEntryForTest(parsedLine);
    if (logLine.msg) {
      logLine.msg = stripAnsi(logLine.msg as string);
    }
    return logLine;
  });

const gitRootFilePath = gitRoot(__dirname);

const sanitizeOutput = (
  spawnResult: Parameters<TestArgs['assert']>[0],
  testDir: Parameters<TestArgs['assert']>[1]
) =>
  stripAnsi(
    replaceAll(replaceAll(spawnResult.stdout, testDir, '<test-dir>'), gitRootFilePath, '<git-root>')
  );

describe('happy path', () => {
  createTest({
    fixtureName: 'prepend-string',
    spawnArgs: [
      '--codemod',
      path.join('codemod', 'codemod.js'),
      '--codemodArgs',
      'a b c',
      '.',
      '!codemod',
    ],
    setUpNodeModules: false,
    snapshot: true,
    assert(spawnResult, testDir) {
      const sanitizedStdout = sanitizeOutput(spawnResult, testDir);
      const findLine = substring =>
        sanitizedStdout.split('\n').find(line => line.includes(substring));

      const postProcessOutput = findLine('codemod post process');
      expect(postProcessOutput).toBeTruthy();
      expect(postProcessOutput).toMatchSnapshot();

      const resultsMetaOutput = findLine('resultMeta as passed to post process');
      expect(resultsMetaOutput).toBeTruthy();
      expect(resultsMetaOutput).toMatchSnapshot();

      const commandLineArgs = findLine('commandLineArgs');
      expect(commandLineArgs).toBeTruthy();
      expect(commandLineArgs).toMatchSnapshot();
    },
  });

  createTest({
    fixtureName: 'transform-all',
    spawnArgs: ['--codemod', path.join('codemod', 'codemod.js'), '.', '!codemod'],
    setUpNodeModules: false,
    snapshot: true,
    assert(spawnResult, testDir) {
      const sanitizedStdout = sanitizeOutput(spawnResult, testDir);
      expect(sanitizedStdout).toMatchSnapshot();
    },
  });

  createTest({
    testName: '--inputFileList',
    fixtureName: 'prepend-string',
    spawnArgs: [
      '--codemod',
      path.join('codemod', 'codemod.js'),
      '--inputFileList',
      'input-file-list.txt',
    ],
    setUpNodeModules: false,
    snapshot: true,
  });

  createTest({
    testName: 'All logging enabled',
    fixtureName: 'prepend-string',
    spawnArgs: [
      '--json-output',
      '--codemod',
      path.join('codemod', 'codemod.js'),
      '--inputFileList',
      'input-file-list.txt',
    ],
    setUpNodeModules: false,
    processOverrides: {
      SILENT: 'true',
      loglevel: 'trace',
    },
    snapshot: true,
    assert(spawnResult, testDir) {
      const sanitizedStdout = getJsonLogs(sanitizeOutput(spawnResult, testDir));
      expect(sanitizedStdout).toMatchSnapshot();
    },
  });

  createTest({
    testName: 'prepend-string with piscina',
    fixtureName: 'prepend-string',
    spawnArgs: [
      '--codemod',
      path.join('codemod', 'codemod.js'),
      '--codemodArgs',
      'a b c',
      '.',
      '!codemod',
      '--piscinaLowerBoundInclusive',
      '1',
    ],
    setUpNodeModules: false,
    snapshot: true,
    assert(spawnResult, testDir) {
      const sanitizedStdout = sanitizeOutput(spawnResult, testDir);
      const findLine = substring =>
        sanitizedStdout.split('\n').find(line => line.includes(substring));

      const postProcessOutput = findLine('codemod post process');
      expect(postProcessOutput).toBeTruthy();
      expect(postProcessOutput).toMatchSnapshot();

      const resultsMetaOutput = findLine('resultMeta as passed to post process');
      expect(resultsMetaOutput).toBeTruthy();
      expect(resultsMetaOutput).toMatchSnapshot();

      const commandLineArgs = findLine('commandLineArgs');
      expect(commandLineArgs).toBeTruthy();
      expect(commandLineArgs).toMatchSnapshot();
    },
  });

  createTest({
    testName: 'dry',
    fixtureName: 'prepend-string',
    spawnArgs: [
      '--dry',
      '--json-output',
      '--codemod',
      path.join('codemod', 'codemod.js'),
      'source',
    ],
    snapshot: true,
    assert(spawnResult, testDir, getRelativeFilePaths) {
      const jsonLogs = getJsonLogs(spawnResult.stdout);
      const inputFilesLogLine = _.find(jsonLogs, 'filesToModify');

      const inputFiles = (inputFilesLogLine as Record<string, unknown>).filesToModify as string[];
      const relativeInputFiles = new Set(getRelativeFilePaths(inputFiles));
      expect(relativeInputFiles).toEqual(
        new Set(['source/.dotfile.js', 'source/a.js', 'source/b.js', 'source/blank.js'])
      );
    },
  });
  createTest({
    testName: 'dry porcelain',
    fixtureName: 'prepend-string',
    spawnArgs: ['--dry', '--porcelain', '--codemod', path.join('codemod', 'codemod.js'), 'source'],
    snapshot: true,
    assert(spawnResult, testDir) {
      const sanitizedStdout = sanitizeOutput(spawnResult, testDir);
      expect(sanitizedStdout).toMatchSnapshot();
    },
  });

  // This test also covers the getPlugin() path.
  createTest({
    testName: 'TS without manually specifying any of the args determining how to compile',
    fixtureName: 'arrow-function-inline-return',
    spawnArgs: ['--codemod', path.join('codemod', 'index.ts'), 'source'],
    snapshot: true,
  });

  createTest({
    testName: 'Run the codemod from outside the fixture dir',
    fixtureName: 'arrow-function-inline-return',
    spawnArgs: ['--codemod', path.join('..', 'codemod', 'index.ts'), '.'],
    getCodemodCwd: testDir => path.join(testDir, 'source'),
    snapshot: true,
  });

  // This test also verifies that, even if the babel plugin changes the AST, if it doesn't call astDidChange(),
  // then the file will not be updated.
  createTest({
    testName: 'getPlugin uses the willNotifyOnAstChange API',
    fixtureName: 'arrow-function-inline-return',
    spawnArgs: [
      '--codemod',
      path.join('codemod', 'index.ts'),
      path.join('source', 'recast-oddities.js'),
    ],
    processOverrides: {
      CALL_WILL_NOTIFY_ON_AST_CHANGE: 'true',
      CALL_AST_DID_CHANGE: 'true',
    },
    snapshot: true,
  });

  createTest({
    testName: 'getPlugin calls astDidChange() but forgot to call willNotifyOnAstChange()',
    fixtureName: 'arrow-function-inline-return',
    spawnArgs: [
      '--codemod',
      path.join('codemod', 'index.ts'),
      path.join('source', 'optional-chaining.js'),
    ],
    expectedExitCode: 1,
    processOverrides: {
      CALL_AST_DID_CHANGE: 'true',
    },
    snapshot: true,
  });

  createTest({
    testName: 'getPlugin returns a meta',
    fixtureName: 'return-meta-from-plugin',
    spawnArgs: ['--codemod', 'codemod.js', 'source'],
    assert(spawnResult, testDir) {
      const sanitizedStdout = sanitizeOutput(spawnResult, testDir);
      expect(sanitizedStdout).toMatchSnapshot();
    },
  });

  createTest({
    testName: 'getPlugin sets useRecast = false',
    fixtureName: 'arrow-function-inline-return',
    spawnArgs: ['--codemod', 'codemod/do-not-use-recast.ts', 'source'],
    snapshot: true,
  });

  describe('getPlugin pass generatorOpts', () => {
    createTest({
      testName: 'useRecast = false',
      fixtureName: 'custom-babel-options',
      spawnArgs: ['--codemod', 'codemod/index.js', 'input.js'],
      snapshot: true,
    });
    createTest({
      testName: 'useRecast = true',
      fixtureName: 'custom-babel-options',
      spawnArgs: ['--codemod', 'codemod/index.js', 'input.js'],
      processOverrides: {
        USE_RECAST: 'true',
      },
      snapshot: true,
    });
  });

  createTest({
    testName: 'codemodArgs parseArgs is passed to postProcess',
    fixtureName: 'parse-args',
    spawnArgs: [
      '--codemod',
      path.join('codemod', 'index.ts'),
      '*.js',
      '--jsonOutput',
      '--',
      '--requiredFlag',
    ],
    assert({ stdout }) {
      const jsonLogs = getJsonLogs(stdout);
      expect(jsonLogs).toContainEqual(
        expect.objectContaining({
          message: 'from postProcess',
          codemodArgs: expect.objectContaining({ requiredFlag: '' }),
        })
      );
    },
  });
});

describe('error handling', () => {
  createTest({
    testName: 'missing pattern of files to transform',
    fixtureName: 'prepend-string',
    spawnArgs: ['--codemod', path.join('codemod', 'codemod.js')],
    expectedExitCode: 1,
  });

  createTest({
    testName: 'missing path to codemod',
    fixtureName: 'prepend-string',
    spawnArgs: ['source'],
    expectedExitCode: 1,
  });

  createTest({
    testName: 'missing required argument to codemod',
    fixtureName: 'parse-args',
    spawnArgs: ['--codemod', path.join('codemod', 'index.ts'), '*.js'],
    expectedExitCode: 1,
    assert({ stderr }) {
      expect(stderr).toMatch(/Missing required argument: requiredFlag/);
    },
  });

  createTest({
    testName: 'passing both --inputFileList and glob pattern',
    fixtureName: 'prepend-string',
    spawnArgs: [
      '--codemod',
      path.join('codemod', 'codemod.js'),
      '--inputFileList',
      'input_files.txt',
      'source/*.js',
    ],
    expectedExitCode: 1,
    assert({ stderr }) {
      expect(stderr).toMatch(/You can't pass both an --inputFileList and a globby pattern./);
    },
  });

  createTest({
    testName: 'pass a built-in codemod that does not exist',
    fixtureName: 'prepend-string',
    spawnArgs: ['--builtInCodemod', 'does-not-exist', 'source/*.js'],
    expectedExitCode: 1,
    assert({ stderr }) {
      expect(stderr).toMatch(
        /Argument: builtInCodemod, Given: "does-not-exist", Choices: "js-to-ts"/
      );
    },
  });

  createTest({
    testName: 'pass a prompt, and a completion param that includes a prompt',
    fixtureName: 'prepend-string',
    spawnArgs: [
      '--completionPrompt',
      'my-prompt',
      '--openAICompletionRequestConfig',
      '{"prompt": "my other prompt"}',
      'source/*.js',
      '--json-output',
    ],
    expectedExitCode: 1,
    assert({ stderr }) {
      expect(stderr).toMatch(
        // eslint-disable-next-line max-len
        /If your API params include a prompt or message, you must not pass a separate prompt or message via the other command line flags./
      );
    },
  });

  createTest({
    testName: 'pass a prompt, and a chat param that includes a prompt',
    fixtureName: 'prepend-string',
    spawnArgs: [
      '--chatMessage',
      'my-prompt',
      '--openAIChatRequestConfig',
      '{"messages": [{"role": "user", "contents": "my other prompt"}]}',
      'source/*.js',
      '--json-output',
    ],
    expectedExitCode: 1,
    assert({ stderr }) {
      expect(stderr).toMatch(
        // eslint-disable-next-line max-len
        /If your API params include a prompt or message, you must not pass a separate prompt or message via the other command line flags./
      );
    },
  });

  createTest({
    testName: 'pass a prompt, and a chat param JSON file that includes a prompt',
    fixtureName: 'ai-validation',
    spawnArgs: [
      '--chatMessage',
      'my-prompt',
      '--openAIChatRequestFile',
      'chat-config.json',
      'source.js',
      '--json-output',
      '--dry',
    ],
    expectedExitCode: 1,
    assert({ stderr }) {
      expect(stderr).toMatch(
        // eslint-disable-next-line max-len
        /If your API params include a prompt or message, you must not pass a separate prompt or message via the other command line flags./
      );
    },
  });

  const createTestForThrowingError = (codemodName: string, codemodFileName: string) =>
    createTest({
      testName: `handles codemod ${codemodName} (${codemodFileName}) throwing an error`,
      fixtureName: 'will-throw-error',
      expectedExitCode: 1,
      spawnArgs: ['--codemod', path.join('codemod', codemodFileName), 'source', '--json-output'],
      snapshot: true,
      assert(spawnResult) {
        const jsonLogs = getJsonLogs(spawnResult.stdout);

        expect(jsonLogs).toContainEqual(
          expect.objectContaining({
            error: expect.objectContaining({
              phase: 'codemod.transform()',
              stack: expect.any(String),
              // I tried to use a regex matcher here but I couldn't get it to work.
              message: expect.stringContaining('source/a.js'),
            }),
          })
        );
        expect(jsonLogs).toContainEqual(
          expect.objectContaining({
            error: expect.objectContaining({
              phase: 'codemod.transform()',
              stack: expect.any(String),
              message: expect.stringContaining('source/b.js'),
            }),
          })
        );
      },
    });

  createTestForThrowingError('codemod-unnamed.js', 'codemod-unnamed.js');
  createTestForThrowingError('my-codemod-name', 'codemod-named.js');
});

describe('TS compilation flags', () => {
  createTest({
    testName: 'Omitting rootDir from tsconfig causes an error',
    fixtureName: 'arrow-function-inline-return',
    spawnArgs: [
      '--codemod',
      path.join('codemod', 'index.ts'),
      '--tsconfig',
      'tsconfig-no-root-dir.json',
      '--jsonOutput',
      'source',
    ],
    expectedExitCode: 1,
    snapshot: true,
    assert(spawnResult, testDir) {
      const sanitizedStdout = getJsonLogs(sanitizeOutput(spawnResult, testDir));
      expect(sanitizedStdout).toMatchSnapshot();
    },
  });

  createTest({
    testName: 'Path to TSC is not specified, and no TSC can be found.',
    fixtureName: 'no-tsc',
    spawnArgs: ['--codemod', path.join('codemod', 'index.ts'), '--json-output', 'input.js'],
    expectedExitCode: 1,
    assert(spawnResult) {
      const jsonLogs = getJsonLogs(spawnResult.stdout);
      expect(jsonLogs).toContainEqual(
        expect.objectContaining({
          // It's more ergonomic to have this be a single string literal.
          // eslint-disable-next-line max-len
          msg: "If you have a TypeScript codemod, and you don't specify a path to a 'tsc' executable that will compile your codemod, then this tool searches in your codemod's node_modules. However, TypeScript could not be found there either.",
        })
      );
    },
  });

  const localTSC = resolveBin.sync('typescript', { executable: 'tsc' });
  createTest({
    testName: 'Path to TSC is specified',
    fixtureName: 'no-tsc',
    spawnArgs: ['--codemod', path.join('codemod', 'index.ts'), '--tsc', localTSC, 'input.js'],
    snapshot: true,
  });

  createTest({
    testName: 'Path to tsconfig is not specified, and no tsconfig can be found.',
    fixtureName: 'tsconfig-non-standard-location',
    spawnArgs: ['--codemod', path.join('codemod', 'index.ts'), '--json-output', 'input.js'],
    expectedExitCode: 1,
    assert(spawnResult) {
      const jsonLogs = getJsonLogs(spawnResult.stdout);
      expect(jsonLogs).toContainEqual(
        expect.objectContaining({
          // It's more ergonomic to have this be a single string literal.
          // eslint-disable-next-line max-len
          msg: 'This tool was not able to find a tsconfig.json file by doing a find-up from codemod. Please manually specify a tsconfig file path.',
        })
      );
    },
  });

  createTest({
    testName: 'Specified tsconfig path',
    fixtureName: 'tsconfig-non-standard-location',
    spawnArgs: [
      '--codemod',
      path.join('codemod', 'index.ts'),
      '--tsconfig',
      path.join('configs', 'tsconfig.json'),
      'input.js',
    ],
    snapshot: true,
  });
});

describe('git', () => {
  createTest({
    testName: 'Reset dirty files',
    fixtureName: 'git-dirty',
    git: true,
    spawnArgs: [
      '--codemod',
      path.join('codemod', 'codemod.js'),
      '--reset-dirty-input-files',
      '--jsonOutput',
      'source',
    ],
    snapshot: true,
    assert(spawnResult, testDir, getRelativeFilePaths) {
      const jsonLogs = getJsonLogs(spawnResult.stdout);
      const modifiedFileLog = _.find(jsonLogs, 'modifiedFiles');
      expect(modifiedFileLog).toBeTruthy();
      const modifiedFiles = new Set(
        getRelativeFilePaths(modifiedFileLog.modifiedFiles as string[])
      );
      expect(modifiedFiles).toMatchInlineSnapshot(`
Set {
  "source/.gitignore",
  "source/dirty.js",
  "source/unmodified.js",
}
`);
    },
  });
  createTest({
    testName: 'Modify dirty files',
    fixtureName: 'git-dirty',
    git: true,
    spawnArgs: ['--codemod', path.join('codemod', 'codemod.js'), 'source'],
    snapshot: true,
  });
});

describe('ignore files', () => {
  createTest({
    testName: 'happy path',
    fixtureName: 'ignorefiles',
    spawnArgs: ['--codemod', 'codemod.js', '**/*.txt'],
    snapshot: true,
  });

  createTest({
    testName: 'missing ignore file',
    fixtureName: 'ignorefiles',
    spawnArgs: ['--codemod', 'codemod-missing-ignore-file.js', '**/*.txt', '--json-output'],
    expectedExitCode: 1,
    assert(spawnResult) {
      const jsonLogs = getJsonLogs(spawnResult.stdout);
      expect(jsonLogs).toContainEqual(
        expect.objectContaining({
          msg: 'Ignore file "does-not-exist.ignore" does not exist.',
        })
      );
    },
  });
});

describe('getTransformedContentsOfSingleFile', () => {
  const log = createLog({ name: 'test' });
  it('returns the contents of a single file', async () => {
    /* eslint-disable no-console */
    console.log = jest.fn().mockImplementation(console.log.bind(console));

    const inputFilePath = path.resolve(__dirname, '../fixtures/prepend-string/source/b.js');
    const originalFilesContents = await fs.readFile(inputFilePath, 'utf-8');
    expect(
      await getTransformedContentsOfSingleFile(
        require.resolve('../fixtures/prepend-string/codemod/codemod.js'),

        // If we use require.resolve here, then Jest will detect it as a test dependency. When the codemod modifies the
        // file, and we're in watch mode, Jest will kick off another run, continuing ad infinitum.
        inputFilePath,
        { log }
      )
    ).toMatchSnapshot();

    expect(originalFilesContents).toEqual(await fs.readFile(inputFilePath, 'utf-8'));

    // @ts-ignore
    const codemodCall = _.find(console.log.mock.calls, { 0: 'codemod post process' });
    expect(codemodCall).toBeFalsy();

    // @ts-ignore
    console.log.mockReset();

    /* eslint-enable no-console */
  });

  it('processes codemod ignored files', async () => {
    const inputFilePath = path.resolve(
      __dirname,
      '../fixtures/prepend-string/source/codemod-ignored.js'
    );
    const originalFilesContents = await fs.readFile(inputFilePath, 'utf-8');
    expect(
      await getTransformedContentsOfSingleFile(
        require.resolve('../fixtures/prepend-string/codemod/codemod.js'),

        // If we use require.resolve here, then Jest will detect it as a test dependency. When the codemod modifies the
        // file, and we're in watch mode, Jest will kick off another run, continuing ad infinitum.
        inputFilePath,
        { log }
      )
    ).toMatchSnapshot();

    expect(originalFilesContents).toEqual(await fs.readFile(inputFilePath, 'utf-8'));
  });

  it('processes ignorefile ignored files', async () => {
    const inputFilePath = path.resolve(__dirname, '../fixtures/ignorefiles/ignored-by-root.txt');
    const originalFilesContents = await fs.readFile(inputFilePath, 'utf-8');
    expect(
      await getTransformedContentsOfSingleFile(
        require.resolve('../fixtures/ignorefiles/codemod.js'),

        // If we use require.resolve here, then Jest will detect it as a test dependency. When the codemod modifies the
        // file, and we're in watch mode, Jest will kick off another run, continuing ad infinitum.
        inputFilePath,
        { log }
      )
    ).toMatchSnapshot();

    expect(originalFilesContents).toEqual(await fs.readFile(inputFilePath, 'utf-8'));
  });

  it('throws an error if the codemod throws an error', async () => {
    const inputFilePath = path.resolve(__dirname, '../fixtures/will-throw-error/source/a.js');
    const originalFilesContents = await fs.readFile(inputFilePath, 'utf-8');

    try {
      await getTransformedContentsOfSingleFile(
        require.resolve('../fixtures/will-throw-error/codemod/codemod-named'),

        // If we use require.resolve here, then Jest will detect it as a test dependency. When the codemod modifies the
        // file, and we're in watch mode, Jest will kick off another run, continuing ad infinitum.
        inputFilePath,
        { log }
      );
      throw new Error('The previous line should have thrown an error');
    } catch (e) {
      // I originally had this test using the Jest helpers, as these lint rules suggest. However, I need to intercept
      // the error value to constantize the snapshot, removing the absolute file path. I tried this with a Jest
      // snapshot serializer, but it gave me a stack overflow, calling the test() function over and over again,
      // and I wasn't able to figure out why.
      //
      // For now, this is fine. But if I start having to do this in more places, I'll revisit the snapshot serializer,
      // which has the benefit of a centralized approach.
      //
      // eslint-disable-next-line jest/no-conditional-expect,jest/no-conditional-expect
      expect(replaceAll(e.toString(), gitRootFilePath, '<git-root>')).toMatchSnapshot();
    }

    expect(originalFilesContents).toEqual(await fs.readFile(inputFilePath, 'utf-8'));
  });
});

describe('execBigCommand', () => {
  it('respects maxArgCount', async () => {
    /* eslint-disable no-magic-numbers */
    const execCommandMock = jest.fn();

    await execBigCommand(
      ['constant arg 1', 'constant arg 2'],
      _.range(0, 20).map(index => `arg-${index}`),
      execCommandMock,
      { maxArgCount: 5 }
    );

    expect(execCommandMock).toHaveBeenCalledTimes(4);
    expect(execCommandMock).toHaveBeenCalledWith([
      'constant arg 1',
      'constant arg 2',
      'arg-0',
      'arg-1',
      'arg-2',
      'arg-3',
      'arg-4',
    ]);
    expect(execCommandMock).toHaveBeenCalledWith([
      'constant arg 1',
      'constant arg 2',
      'arg-5',
      'arg-6',
      'arg-7',
      'arg-8',
      'arg-9',
    ]);
    expect(execCommandMock).toHaveBeenCalledWith([
      'constant arg 1',
      'constant arg 2',
      'arg-10',
      'arg-11',
      'arg-12',
      'arg-13',
      'arg-14',
    ]);
    expect(execCommandMock).toHaveBeenCalledWith([
      'constant arg 1',
      'constant arg 2',
      'arg-15',
      'arg-16',
      'arg-17',
      'arg-18',
      'arg-19',
    ]);
    /* eslint-enable no-magic-numbers */
  });

  it('has defaults for options', async () => {
    const execCommandMock = jest.fn();

    await execBigCommand(['constant arg 1', 'constant arg 2'], ['variable arg'], execCommandMock);

    expect(execCommandMock).toHaveBeenCalledTimes(1);
  });
});
