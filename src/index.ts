import globby from 'globby';
import _ from 'lodash';
import execa from 'execa';
import pathIsTS from './path-is-ts';
import path from 'path';
import Piscina from 'piscina';
import ProgressBar from 'progress';
import {cyan} from 'ansi-colors';
import ora from 'ora';
import createLog from 'nth-log';
import compileTS from './compile-ts';
import {Codemod, TODO} from './types';
import execBigCommand from './exec-big-command';
import getGitRoot from './get-git-root';
import loadCodemod from './load-codemod';
import gitignore from './gitignore';
import getCodemodName from './get-codemod-name';
import runCodemodOnFile, {CodemodMetaResult} from './run-codemod-on-file';
import noOpLogger from './no-op-logger';
import {promises as fs} from 'fs';
import {EOL} from 'os';
import prettyMs from 'pretty-ms';

export {default as getTransformedContentsOfSingleFile} from './get-transformed-contents-of-single-file';
export {default as execBigCommand} from './exec-big-command';

export type TSOptions = {
  tsconfig?: string;
  tsOutDir?: string
  tsc?: string;
  log: ReturnType<typeof createLog>;
}

export type NonTSOptions = {
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
}
& ({
  inputFileList: string;
  inputFilesPatterns?: never;
} | {
  inputFileList?: never;
  inputFilesPatterns: string[];
})

export type Options = Omit<TSOptions, 'log'> & Partial<Pick<TSOptions, 'log'>> & NonTSOptions;

type FalseyDefaultOptions = 'dry' | 'porcelain' | 'codemodArgs' | 'resetDirtyInputFiles' | 'jsonOutput'
  | 'piscinaLowerBoundInclusive' | 'inputFileList' | 'inputFilesPatterns';
export type InternalOptions = TSOptions
  & Pick<NonTSOptions, FalseyDefaultOptions>
  & Required<Omit<NonTSOptions, FalseyDefaultOptions>>;

// The rule is too broad.
// eslint-disable-next-line require-await
async function getCodemodPath(pathToCodemod: string, options: TSOptions) {
  if (pathIsTS(pathToCodemod)) {
    return compileTS(pathToCodemod, options);
  }

  return path.resolve(pathToCodemod);
}

function getProgressUI(logOpts: Pick<Options, 'porcelain' | 'jsonOutput'>, totalCount: number) {
  if (logOpts.porcelain || logOpts.jsonOutput) {
    // This is intentional.
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    return {tick() {}};
  }

  return new ProgressBar(':bar (:current/:total, :percent)', {total: totalCount});
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

async function transformCode(
  codemod: Codemod,
  log: TSOptions['log'],
  codemodPath: string,
  inputFiles: string[],
  writeFiles: boolean,
  piscinaLowerBoundInclusive: NonTSOptions['piscinaLowerBoundInclusive'],
  logOpts: Pick<Options, 'porcelain' | 'jsonOutput'>, codemodArgs?: string[]
) {
  const rawArgs = codemodArgs ? JSON.stringify(codemodArgs) : undefined;

  const baseRunnerOpts = {
    codemodArgs: rawArgs, writeFiles, codemodPath
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
      argv: [codemodPath],
      workerData: {...baseRunnerOpts, logOpts}
    });

    registerForPiscinaDrain = () => {
      piscina.on('drain', () => {
        log.info(
          _.pick(piscina, 'runTime', 'waitTime', 'duration', 'completed', 'utilization'),
          'Piscina pool drained.'
        );
      });
    };

    destroyPiscinaIfNecessary = piscina.destroy.bind(piscina);

    return piscina;
  });

  // For next time: see what happens if we put all IO in the main thread. Perhaps limit it there too.

  const runCodemodOnSingleFile = (inputFile: string): Promise<CodemodMetaResult<unknown>> => {
    const runStartTimeMs = Date.now();
    if (inputFiles.length >= (piscinaLowerBoundInclusive ?? defaultPiscinaLowerBoundInclusive)) {
      return getPiscina().runTask({inputFile, runStartTimeMs});
    }

    return runCodemodOnFile(codemod, inputFile, log, baseRunnerOpts, runStartTimeMs);
  };

  const progressBar = getProgressUI(logOpts, inputFiles.length);
  // We might be doing something to hurt perf here.
  // https://github.com/piscinajs/piscina/issues/145

  const codemodStartTimeMs = Date.now();
  const logTimeToChangeFirstFile = _.once(() => {
    const timeToChangeFirstFile = Date.now() - codemodStartTimeMs;
    log.debug({
      durationMs: timeToChangeFirstFile,
      durationMsPretty: prettyMs(timeToChangeFirstFile)
    }, 'The first codemod worker to return has done so.');
  });
  const allFilesCodemoddedPromise = Promise.all(inputFiles.map(async inputFile => {
    const codemodMetaResult = await runCodemodOnSingleFile(inputFile);
    logTimeToChangeFirstFile();
    log.debug({
      ...codemodMetaResult,
      fileContents: '<truncated file contents>'
    });
    progressBar.tick();
    return codemodMetaResult;
  }));

  registerForPiscinaDrain();

  const allFilesCodemodded = await allFilesCodemoddedPromise;

  destroyPiscinaIfNecessary();

  return allFilesCodemodded;
}

function execGit(gitRoot: string, args: string[]): Promise<execa.ExecaReturnValue> {
  return execa('git', args, {cwd: gitRoot});
}

async function resetDirtyInputFiles(gitRoot: string | null, filesToModify: string[], log: TODO) {
  if (!gitRoot) {
    throw new Error('If you pass option "resetDirtyInputFiles", then all files must be in the same git root. ' +
      'However, no git root was found.');
  }
  const dirtyFiles = (await execGit(gitRoot, ['status', '--porcelain'])).stdout.split('\n')
    // This assumes that none of the file paths have spaces in them.
    // It would be better to just split on the first ' ' we see.
    .map(line => line.trim().split(' '))
    .filter(([statusCode]) => statusCode === 'M')
    .map(([_statusCode, filePath]) => path.join(gitRoot, filePath));

  const dirtyInputFiles = _.intersection(dirtyFiles, filesToModify);
  log.debug({modifiedInputFiles: dirtyInputFiles, count: dirtyInputFiles.length});

  if (dirtyInputFiles.length) {
    const spinner =
      ora(`Restoring ${cyan(dirtyInputFiles.length.toString())} dirty files to a clean state.`).start();
    await execBigCommand(['restore', '--staged'], dirtyInputFiles, (args: string[]) => execGit(gitRoot, args), log);
    await execBigCommand(['restore'], dirtyInputFiles, (args: string[]) => execGit(gitRoot, args), log);
    spinner.succeed();
  }
}

async function getIsIgnoredByIgnoreFile(log: TODO, ignoreFiles: string[] | undefined) {
  if (ignoreFiles) {
    try {
      return await gitignore({paths: ignoreFiles});
    } catch (e) {
      // TODO: throw an error if the ignorefile path isn't absolute.
      if (e.code === 'ENOENT') {
        log.error({invalidIgnoreFilePath: e.file}, `Ignore file "${e.file}" does not exist.`);
        throw e;
      }
    }
  }

  return () => false;
}

async function jscodemod(
  pathToCodemod: string,
  passedOptions: Options
// TODO: encode that this return type depends on whether 'dry' is passed.
): Promise<CodemodMetaResult<unknown>[] | string[]> {
  const {
    log,
    doPostProcess,
    writeFiles,
    inputFilesPatterns,
    inputFileList,
    ...options
  }: InternalOptions = {
    log: noOpLogger,
    doPostProcess: true,
    writeFiles: true,
    respectIgnores: true,
    ...passedOptions
  };

  const codemodPath = await getCodemodPath(pathToCodemod, {
    ..._.pick(options, 'tsconfig', 'tsOutDir', 'tsc'),
    log
  });

  const codemod = loadCodemod(codemodPath);
  const codemodName = getCodemodName(codemod, codemodPath);

  log.debug({codemodPath, codemodName, codemodKeys: Object.keys(codemod)});

  // The next line is a bit gnarly to make TS happy.
  const codemodIgnores = _.compact(([] as (RegExp | string | undefined)[]).concat(codemod.ignore));
  const isIgnoredByIgnoreFile = await getIsIgnoredByIgnoreFile(log, codemod.ignoreFiles);

  async function getInputFilesBeforeIgnores() {
    if (inputFilesPatterns) {
      return log.logPhase({
        phase: 'globbing',
        level: 'debug',
        inputFilesPatterns
      }, () => globby(inputFilesPatterns, {dot: true, gitignore: true}));
    }

    if (inputFileList) {
      const fileContents = await fs.readFile(inputFileList, 'utf8');
      return _.compact(fileContents.trim().split(EOL));
    }

    throw new Error('You must specify one of these options: `inputFilesPatterns` or `inputFileList`');
  }

  const inputFilesBeforeIgnores = await getInputFilesBeforeIgnores();

  log.debug({
    codemodName,
    // Workaround for https://github.com/NickHeiner/nth-log/issues/12.
    codemodIgnores: codemodIgnores.map(re => re.toString()),
    codemodIgnoreFiles: codemod.ignoreFiles,
    inputFilesBeforeIgnores
  }, 'Filtering input file patterns.');

  const filesToModify = _(inputFilesBeforeIgnores)
    .map(filePath => path.resolve(filePath))
    .reject(filePath =>
      options.respectIgnores &&
      (
        _.some(codemodIgnores, ignorePattern =>
          typeof ignorePattern === 'string' ? filePath.includes(ignorePattern) : ignorePattern.test(filePath)
        ) ||
        isIgnoredByIgnoreFile(filePath)
      )
    )
    .sort()
    .value();

  if (!filesToModify.length) {
    const err = new Error('No files were found to transform.');
    Object.assign(err, {inputFilesPatterns});
    throw err;
  }

  const logMethod = options.dry ? 'info' : 'debug';
  log[logMethod](
    {filesToModify, count: filesToModify.length, inputFilesPatterns, codemodName},
    'Found files to modify.'
  );

  // TODO: I don't like setting an expectation that codemods should call process.exit themselves, but it's convenient
  // because it's what yargs does by default. The codemod could also stop the process by throwing an exception, which
  // I also don't love.
  const handleExit = () =>
    // I think bunyan is too verbose here.
    // eslint-disable-next-line no-console
    console.error("The codemod's parseArgs method called process.exit(). " +
      "This probably means the arguments you passed to it didn't validate. To pass arguments to a codemod, " +
      "put them at the end of the whole command, like 'jscodemod -c codemod.js fileGlob -- -a b'.");
  process.on('exit', handleExit);
  const parsedArgs = await codemod.parseArgs?.(options.codemodArgs);
  log.debug({codemodName, parsedArgs});
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
  log.debug({gitRoot, codemodName});

  if (options.resetDirtyInputFiles) {
    await resetDirtyInputFiles(gitRoot, filesToModify, log);
  }

  const codemodMetaResults = await transformCode(codemod, log, codemodPath, filesToModify, writeFiles,
    passedOptions.piscinaLowerBoundInclusive, _.pick(passedOptions, 'jsonOutput', 'porcelain'), options.codemodArgs
  );
  if (typeof codemod.postProcess === 'function' && doPostProcess) {
    const modifiedFiles = _(codemodMetaResults).filter('codeModified').map('filePath').value();

    const codemodMeta = new Map(
      codemodMetaResults.map(({filePath, meta}) => [filePath, meta])
    );

    // TODO: if the postProcess phase fails, there's no way for that to propagate back up to the caller, which means
    // we can't exit with a non-zero code.
    await log.logPhase({
      phase: 'postProcess',
      modifiedFiles,
      codemodName,
      level: 'debug'
      // This non-null assertion is safe because if we verififed above that `postProcess` is defined, it will not
      // have been undefined by the time this executes.
      // @ts-expect-error TODO clean this up
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    }, () => codemod.postProcess!(modifiedFiles, {
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
          ...optionsFromPostProcess
        });
      }
    }));
  }
  return codemodMetaResults;
}

export default jscodemod;