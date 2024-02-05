// This file has terminal UI logic.
/* eslint-disable no-console */

import globby from 'globby';
import _ from 'lodash';
import execa from 'execa';
import pathIsTS from './path-is-ts';
import path from 'path';
import Piscina from 'piscina';
import ProgressBar from 'progress';
import { cyan } from 'ansi-colors';
import ora from 'ora';
import createLog from 'nth-log';
import compileTS from './compile-ts';
import type { AIChatCodemod, AICompletionCodemod, Codemod, TODO } from './types';
import execBigCommand from './exec-big-command';
import getGitRoot from './get-git-root';
import loadCodemod from './load-codemod';
import gitignore from './gitignore';
import getCodemodName from './get-codemod-name';
import runCodemodOnFile, { CodemodMetaResult } from './run-codemod-on-file';
import noOpLogger from './no-op-logger';
import { promises as fs } from 'fs';
import { EOL } from 'os';
import prettyMs from 'pretty-ms';
import type { OpenAI } from 'openai';
import buildFullPrompt from './build-full-prompt';

export { default as getTransformedContentsOfSingleFile } from './get-transformed-contents-of-single-file';
export { default as execBigCommand } from './exec-big-command';
export * from './types';

/**
 * Options regarding how a TS codemod will be run.
 */
export type TSOptions = {
  tsconfig?: string;
  tsOutDir?: string;
  /**
   * If true, when you pass a TS codemod, JSCodemod will compile it.
   *
   * When false, JSCodemod will `require()` the TS codemod directly.
   *
   * You'd want to pass `false` if you were calling JSCodemod from a context where `require()`ing TS directly works. For
   * instance, if you have ts-node enabled.
   *
   * Defaults to true.
   */
  compileTs?: boolean;
  tsc?: string;
  log: ReturnType<typeof createLog>;
};

export type BaseOptions = {
  dry?: boolean;
  writeFiles?: boolean;
  porcelain?: boolean;
  jsonOutput?: boolean;
  codemodArgs?: string[];
  // TODO: It would be helpful to make this more powerful. A multi-phase codemod may touch multiple sets of files.
  // Codemods in the later phase shouldn't resetDirtyInputFiles that are only dirty because they're modified by an
  // earlier phase.
  resetDirtyInputFiles?: boolean;
  doPostProcess?: boolean;
  respectIgnores?: boolean;
  piscinaLowerBoundInclusive?: number;
  openAIAPIRequestParams?: OpenAI.CompletionCreateParamsNonStreaming | OpenAI.ChatCompletionCreateParamsNonStreaming;
} & (
  | {
      inputFileList: string;
      inputFilesPatterns?: never;
    }
  | {
      inputFileList?: never;
      inputFilesPatterns: string[];
    }
);

export type Options = Omit<TSOptions, 'log'> & Partial<Pick<TSOptions, 'log'>> & BaseOptions;

type FalseyDefaultOptions =
  | 'dry'
  | 'porcelain'
  | 'codemodArgs'
  | 'resetDirtyInputFiles'
  | 'jsonOutput'
  | 'piscinaLowerBoundInclusive'
  | 'inputFileList'
  | 'inputFilesPatterns'
  | 'openAIAPIRequestParams';
export type InternalOptions = TSOptions &
  Pick<BaseOptions, FalseyDefaultOptions> &
  Required<Omit<BaseOptions, FalseyDefaultOptions>>;

// The rule is too broad.
// eslint-disable-next-line require-await
async function getCodemodPath(pathToCodemod: string, options: TSOptions) {
  if (pathIsTS(pathToCodemod) && options.compileTs) {
    return compileTS(pathToCodemod, options);
  }

  return path.resolve(pathToCodemod);
}

function getProgressUI(
  logOpts: Pick<Options, 'porcelain' | 'jsonOutput'>,
  totalCount: number,
  codemodName: string
) {
  if (logOpts.porcelain || logOpts.jsonOutput) {
    // This is intentional.
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    return { tick() {} };
  }

  return new ProgressBar(`[${codemodName}] :bar (:current/:total, :percent)`, {
    total: totalCount,
  });
}

/**
 * Only use Piscina if there are at least this many files.
 * At smaller input sizes, Piscina's fixed startup cost isn't justified by the per-file gains. In my anecdotal test,
 * running a simple codemod on a single file took ~5 seconds with Piscina and ~2 seconds when kept in-process.
 *
 * Also, creating multiple piscina worker pools simultaneously seems to have a super-linear cost. I ran into this when
 * writing tests which by default ran simultaneously. 1 simultaneous worker pool took ~5 seconds, 2 took ~20, 3 took
 * ~50, etc.
 */
export const defaultPiscinaLowerBoundInclusive = 20;

// TODO: multi-stage codemods currently need to be in separate files for each codemod, which can be a little awkward
// and inhibit code sharing
function transformCode(
  codemod: Codemod,
  log: TSOptions['log'],
  codemodPath: string | null,
  inputFiles: string[],
  piscinaLowerBoundInclusive: BaseOptions['piscinaLowerBoundInclusive'],
  logOpts: Pick<Options, 'porcelain' | 'jsonOutput'>,
  parsedArgs: unknown,
  codemodArgs?: string[]
) {
  const rawArgs = codemodArgs ? JSON.stringify(codemodArgs) : undefined;

  const baseRunnerOpts = {
    codemodArgs: rawArgs,
    codemodPath,
  };

  // We intentionally want a noop.
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  let destroyPiscinaIfNecessary = () => {};
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  let registerForPiscinaDrain = () => {};

  // TODO: Maybe set the maxThreads lower to avoid eating all the CPU.
  const getPiscina = _.once(() => {
    const piscina = new Piscina({
      filename: require.resolve('./worker'),
      argv: [
        // We've proven by this point in the code that this is safe.
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        codemodPath!,
      ],
      workerData: { ...baseRunnerOpts, logOpts },
    });

    registerForPiscinaDrain = () => {
      piscina.on('drain', () => {
        log.debug(
          _.pick(piscina, 'runTime', 'waitTime', 'duration', 'completed', 'utilization'),
          'Piscina pool drained.'
        );
      });
    };

    destroyPiscinaIfNecessary = piscina.destroy.bind(piscina);

    return piscina;
  });

  const codemodName = getCodemodName(codemod, codemodPath);
  const progressBar = getProgressUI(logOpts, inputFiles.length, codemodName);
  // We might be doing something to hurt perf here.
  // https://github.com/piscinajs/piscina/issues/145

  const codemodStartTimeMs = Date.now();
  const logTimeToChangeFirstFile = _.once(() => {
    const timeToChangeFirstFile = Date.now() - codemodStartTimeMs;
    log.debug(
      {
        durationMs: timeToChangeFirstFile,
        durationMsPretty: prettyMs(timeToChangeFirstFile),
      },
      'The first codemod worker to return has done so.'
    );
  });

  async function codemodAllFiles() {
    if ('transformAll' in codemod) {
      return codemod.transformAll({
        fileNames: inputFiles,
        commandLineArgs: parsedArgs,
      });
    }
    const allFilesCodemoddedPromise = Promise.all(
      inputFiles.map(async inputFile => {
        const runCodemodOnSingleFile = (inputFile: string): Promise<CodemodMetaResult<unknown>> => {
          const runStartTimeMs = Date.now();
          if (
            inputFiles.length >= (piscinaLowerBoundInclusive ?? defaultPiscinaLowerBoundInclusive)
          ) {
            return getPiscina().runTask({ inputFile, runStartTimeMs });
          }

          return runCodemodOnFile(codemod, inputFile, log, baseRunnerOpts, runStartTimeMs);
        };
        const codemodMetaResult = await runCodemodOnSingleFile(inputFile);
        logTimeToChangeFirstFile();
        log.debug({
          ...codemodMetaResult,
          fileContents: '<truncated file contents>',
        });
        progressBar.tick();
        return codemodMetaResult;
      })
    );

    registerForPiscinaDrain();

    const allFilesCodemodded = await allFilesCodemoddedPromise;

    destroyPiscinaIfNecessary();

    return allFilesCodemodded;
  }

  return codemodAllFiles();
}

function execGit(gitRoot: string, args: string[]): Promise<execa.ExecaReturnValue> {
  return execa('git', args, { cwd: gitRoot });
}

async function resetDirtyInputFiles(gitRoot: string | null, filesToModify: string[], log: TODO) {
  if (!gitRoot) {
    throw new Error(
      'If you pass option "resetDirtyInputFiles", then all files must be in the same git root. ' +
        'However, no git root was found.'
    );
  }
  const dirtyFiles = (await execGit(gitRoot, ['status', '--porcelain'])).stdout
    .split('\n')
    // This assumes that none of the file paths have spaces in them.
    // It would be better to just split on the first ' ' we see.
    .map(line => line.trim().split(' '))
    .filter(([statusCode]) => statusCode === 'M')
    .map(([_statusCode, filePath]) => path.join(gitRoot, filePath));

  const dirtyInputFiles = _.intersection(dirtyFiles, filesToModify);
  log.debug({ modifiedInputFiles: dirtyInputFiles, count: dirtyInputFiles.length });

  if (dirtyInputFiles.length) {
    const spinner = ora(
      `Restoring ${cyan(dirtyInputFiles.length.toString())} dirty files to a clean state.`
    ).start();
    await execBigCommand(
      ['restore', '--staged'],
      dirtyInputFiles,
      (args: string[]) => execGit(gitRoot, args),
      log
    );
    await execBigCommand(
      ['restore'],
      dirtyInputFiles,
      (args: string[]) => execGit(gitRoot, args),
      log
    );
    spinner.succeed();
  }
}

type GitignoreError = Error & { code?: string; file: string };

async function getIsIgnoredByIgnoreFile(log: TODO, ignoreFiles: string[] | undefined) {
  if (ignoreFiles) {
    try {
      return await gitignore({ paths: ignoreFiles });
    } catch (e) {
      const err = e as GitignoreError;
      // TODO: throw an error if the ignorefile path isn't absolute.
      if (err.code === 'ENOENT') {
        log.error({ invalidIgnoreFilePath: err.file }, `Ignore file "${err.file}" does not exist.`);
        throw e;
      }
      throw e;
    }
  }

  return () => false;
}

async function jscodemod(
  pathToCodemod: string | undefined,
  passedOptions: Options
  // TODO: encode that this return type depends on whether 'dry' is passed.
): Promise<CodemodMetaResult<unknown>[] | string[]> {
  const { log, doPostProcess, inputFilesPatterns, inputFileList, ...options }: InternalOptions = {
    log: noOpLogger,
    doPostProcess: true,
    writeFiles: true,
    respectIgnores: true,
    compileTs: true,
    ...passedOptions,
  };

  async function getCodemod() {
    const { openAIAPIRequestParams } = options;
    if (openAIAPIRequestParams) {
      let codemod: AICompletionCodemod | AIChatCodemod;
      if (
        'prompt' in openAIAPIRequestParams &&
        openAIAPIRequestParams.prompt &&
        typeof openAIAPIRequestParams.prompt === 'string'
      ) {
        const { prompt } = openAIAPIRequestParams;
        codemod = {
          name: 'codemod-generated-from-CLI-flags',
          getGlobalAPIRequestParams: () => openAIAPIRequestParams,
          getPrompt: source => buildFullPrompt(prompt, source),
        } satisfies AICompletionCodemod;
      } else if ('messages' in openAIAPIRequestParams) {
        codemod = {
          name: 'codemod-generated-from-CLI-flags',
          getGlobalAPIRequestParams: () => openAIAPIRequestParams as OpenAI.ChatCompletionCreateParamsNonStreaming,
          getMessages: source => [
            ...(openAIAPIRequestParams as OpenAI.ChatCompletionCreateParamsNonStreaming).messages,
            { role: 'user', content: source },
          ],
        } satisfies AIChatCodemod;
      } else {
        const promptThatWasPassed =
          openAIAPIRequestParams.prompt ||
          ('messages' in openAIAPIRequestParams && openAIAPIRequestParams.messages);

        /* eslint-disable max-len */
        throw new Error(`To run an AI codemod, you can do one of two things:
  1. Pass \`openAIAPIRequestParams\` or \`openAIChatRequestParams\`.
  2. Pass a path to a codemod that implements the AICodemod type.

  In case (1), your prompt must be a string. However, your prompt was "${promptThatWasPassed}". If you want a non-string prompt, use option (2) listed above.`);
        /* eslint-enable max-len */
      }

      return { codemod, codemodName: codemod.name, codemodPath: null };
    }
    if (!pathToCodemod) {
      throw new Error('You must pass either `openAIAPIRequestParams`, or a path to a codemod.');
    }

    const codemodPath = await getCodemodPath(pathToCodemod, {
      ..._.pick(options, 'tsconfig', 'tsOutDir', 'tsc', 'compileTs'),
      log,
    });
    const codemod = loadCodemod(codemodPath);
    const codemodName = getCodemodName(codemod, codemodPath);

    return { codemod, codemodName, codemodPath };
  }

  const { codemod, codemodPath, codemodName } = await getCodemod();

  // This is intentional.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function safeConsoleLog(...args: any[]) {
    if (passedOptions.jsonOutput || passedOptions.porcelain) {
      return;
    }

    console.log(...args);
  }

  // TODO: it would be nice if we used log.child to make all logs from here on out have the codemod name.
  const codemodIsTransformAll = 'transformAll' in codemod;
  const writeFiles = !codemodIsTransformAll && options.writeFiles;

  log.debug({
    codemodPath,
    codemodName,
    codemodKeys: Object.keys(codemod),
    codemodIgnoreFiles: codemod.ignoreFiles,
  });

  // The next line is a bit gnarly to make TS happy.
  const codemodIgnores = _.compact(([] as (RegExp | string | undefined)[]).concat(codemod.ignore));
  const isIgnoredByIgnoreFile = await getIsIgnoredByIgnoreFile(log, codemod.ignoreFiles);

  async function getInputFilesBeforeIgnores() {
    if (inputFilesPatterns) {
      return log.logPhase(
        {
          phase: 'globbing',
          level: 'debug',
          inputFilesPatterns,
        },
        () => globby(inputFilesPatterns, { dot: true, gitignore: true })
      );
    }

    if (inputFileList) {
      const fileContents = await fs.readFile(inputFileList, 'utf8');
      return _.compact(fileContents.trim().split(EOL));
    }

    throw new Error(
      'You must specify one of these options: `inputFilesPatterns` or `inputFileList`'
    );
  }

  const inputFilesBeforeIgnores = await getInputFilesBeforeIgnores();

  log.debug(
    {
      codemodName,
      // Workaround for https://github.com/NickHeiner/nth-log/issues/12.
      codemodIgnores: codemodIgnores.map(re => re.toString()),
      codemodIgnoreFiles: codemod.ignoreFiles,
      inputFilesBeforeIgnores,
    },
    'Filtering input file patterns.'
  );

  const filesToModify = _(inputFilesBeforeIgnores)
    .map(filePath => path.resolve(filePath))
    .reject(
      filePath =>
        options.respectIgnores &&
        (_.some(codemodIgnores, ignorePattern =>
          typeof ignorePattern === 'string'
            ? filePath.includes(ignorePattern)
            : ignorePattern.test(filePath)
        ) ||
          isIgnoredByIgnoreFile(filePath))
    )
    .sort()
    .value();

  if (!filesToModify.length) {
    const err = new Error('No files were found to transform.');
    Object.assign(err, { inputFilesPatterns, codemodName });
    throw err;
  }

  const logMethod = options.dry ? 'info' : 'debug';
  log[logMethod](
    { filesToModify, count: filesToModify.length, inputFilesPatterns, codemodName },
    'Found files to modify.'
  );

  // TODO: I don't like setting an expectation that codemods should call process.exit themselves, but it's convenient
  // because it's what yargs does by default. The codemod could also stop the process by throwing an exception, which
  // I also don't love.
  const handleExit = () =>
    // I think bunyan is too verbose here.
    // eslint-disable-next-line no-console
    console.error(
      "The codemod's parseArgs method called process.exit(). " +
        "This probably means the arguments you passed to it didn't validate. To pass arguments to a codemod, " +
        "put them at the end of the whole command, like 'jscodemod -c codemod.js fileGlob -- -a b'."
    );
  process.on('exit', handleExit);
  const parsedArgs = await codemod.parseArgs?.(options.codemodArgs);
  log.debug({ codemodName, parsedArgs });
  process.off('exit', handleExit);

  if (options.dry) {
    if (options.porcelain) {
      // We want undecorated output for porcelain.
      // eslint-disable-next-line no-console
      filesToModify.forEach(filePath => console.log(filePath));
    } else {
      log.info('Exiting early because "dry" was set.');
    }
    return filesToModify;
  }

  const gitRoot = await getGitRoot(filesToModify);
  log.debug({ gitRoot, codemodName });

  if (options.resetDirtyInputFiles) {
    await resetDirtyInputFiles(gitRoot, filesToModify, log);
  }

  const piscinaLowerBoundInclusive = passedOptions.openAIAPIRequestParams
    ? Infinity
    : passedOptions.piscinaLowerBoundInclusive;
  const transformResults = await transformCode(
    codemod,
    log,
    codemodPath,
    filesToModify,
    piscinaLowerBoundInclusive,
    _.pick(passedOptions, 'jsonOutput', 'porcelain'),
    parsedArgs,
    options.codemodArgs
  );

  /**
   * Room for improvement: this approach transforms all files in one pass, then writes them to disk. This is fine for
   * smaller codemods. But for bigger codemods, particularly AI ones where you need to iterate a lot, this isn't ideal.
   * You don't get any feedback on what the transformation looks like until everything is done, which if you're rate
   * limited, can be a long time.
   *
   * And, this is potentially slower, because we could be doing writes while awaiting one last codemod file to return.
   * (Of course, for AI codemods, this is unlikely to have a measurable effect.)
   */
  if (writeFiles) {
    const codemodMetaResults = transformResults as Exclude<typeof transformResults, string[]>;
    const filesToWrite = _.filter(codemodMetaResults, 'codeModified');
    safeConsoleLog(`🔨 Writing "${filesToWrite.length}" modified files`);
    await Promise.all(
      filesToWrite.map(codemodMetaResult => {
        // This next validation and throw is just to make TS happy.
        if (codemodMetaResult.action !== 'modified') {
          throw new Error('jscodemod logic error: Attempted to write an unmodified file.');
        }

        log.debug({ filePath: codemodMetaResult.filePath }, 'Writing modified file');
        return fs.writeFile(codemodMetaResult.filePath, codemodMetaResult.fileContents);
      })
    );
  }

  if (typeof codemod.postProcess === 'function' && doPostProcess) {
    function getPostProcessArgs() {
      if (codemodIsTransformAll) {
        return {
          modifiedFiles: transformResults,
          codemodMeta: new Map(),
        };
      }
      const codemodMetaResults = transformResults as Exclude<typeof transformResults, string[]>;
      return {
        modifiedFiles: _(codemodMetaResults).filter('codeModified').map('filePath').value(),
        codemodMeta: new Map(codemodMetaResults.map(({ filePath, meta }) => [filePath, meta])),
      };
    }

    const { modifiedFiles, codemodMeta } = getPostProcessArgs();

    safeConsoleLog(`🔨 Running postProcess for "${modifiedFiles.length}" modified files...`);
    // TODO: if the postProcess phase fails, there's no way for that to propagate back up to the caller, which means
    // we can't exit with a non-zero code.
    await log.logPhase(
      {
        phase: 'postProcess',
        modifiedFiles,
        codemodName,
        level: 'debug',
      },
      () =>
        // This non-null assertion is safe because if we verififed above that `postProcess` is defined, it will not
        // have been undefined by the time this executes.
        // @ts-expect-error TODO clean this up
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        codemod.postProcess!(modifiedFiles, {
          // TODO: sometimes it's "codemodArgs", and sometimes it's "commandLineArgs"
          codemodArgs: parsedArgs,
          resultMeta: codemodMeta,
          jscodemod(pathToCodemod: string, optionsFromPostProcess: Partial<Options>) {
            /**
             * I'm pretty sure this is complaining because it's possible for `passedOptions` to include one of
             * `inputFileList` and `inputFilesPattern`, and `optionsFromPostProcess` to include the other, which is not
             * permitted by the typings. I'll trust that the caller handles that case, passing `null` if they need to
             * override `passedOptions`.
             */
            // @ts-expect-error
            return jscodemod(pathToCodemod, {
              ...passedOptions,
              ...optionsFromPostProcess,
            });
          },
        })
    );
    safeConsoleLog('✅ postProcess done.');
  }
  return transformResults;
}

export default jscodemod;
