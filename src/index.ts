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

export type Options = Omit<TSOptions, 'log'> & Partial<Pick<TSOptions, 'log'>> & NonTSOptions;

type FalseyDefaultOptions = 'dry' | 'porcelain' | 'codemodArgs' | 'resetDirtyInputFiles' | 'jsonOutput'
  | 'piscinaLowerBoundInclusive';
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

function transformCode(
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

  // TODO: Maybe set the maxThreads lower to avoid eating all the CPU.
  const getPiscina = _.once(() => new Piscina({
    filename: require.resolve('./worker'),
    argv: [codemodPath],
    workerData: {...baseRunnerOpts, logOpts}
  }));

  const runCodemodOnSingleFile = (inputFile: string) => {
    if (inputFiles.length >= (piscinaLowerBoundInclusive ?? defaultPiscinaLowerBoundInclusive)) {
      return getPiscina().runTask(inputFile);
    }

    return runCodemodOnFile(codemod, inputFile, log, baseRunnerOpts);
  };

  const progressBar = getProgressUI(logOpts, inputFiles.length);
  return Promise.all(inputFiles.map(async inputFile => {
    const codemodMetaResult: CodemodMetaResult = await runCodemodOnSingleFile(inputFile);
    log.debug({
      ...codemodMetaResult,
      fileContents: '<truncated file contents>'
    });
    progressBar.tick();
    return codemodMetaResult;
  }));
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
  inputFilesPatterns: string[],
  passedOptions: Options = {}
): Promise<CodemodMetaResult[] | string[]> { // TODO: encode that this return type depends on whether 'dry' is passed.
  const {
    log,
    doPostProcess,
    writeFiles,
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

  const globbedFiles = await log.logPhase({
    phase: 'globbing',
    level: 'debug',
    inputFilesPatterns
  }, () => globby(inputFilesPatterns, {dot: true, gitignore: true}));

  log.debug({
    codemodName,
    // Workaround for https://github.com/NickHeiner/nth-log/issues/12.
    codemodIgnores: codemodIgnores.map(re => re.toString()),
    codemodIgnoreFiles: codemod.ignoreFiles,
    globbedFiles
  }, 'Filtering input file patterns.');

  const filesToModify = _(globbedFiles)
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

    // TODO: if the postProcess phase fails, there's no way for that to propagate back up to the caller, which means
    // we can't exit with a non-zero code.
    await log.logPhase({
      phase: 'postProcess',
      modifiedFiles,
      codemodName,
      level: 'debug'
      // This non-null assertion is safe because if we verififed above that `postProcess` is defined, it will not
      // have been undefined by the time this executes.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    }, () => codemod.postProcess!(modifiedFiles, {
      codemodArgs: parsedArgs,
      jscodemod(pathToCodemod: string, inputFilesPatterns: string[], options: Partial<Options>) {
        return jscodemod(pathToCodemod, inputFilesPatterns, {
          ...passedOptions,
          ...options
        });
      }
    }));
  }
  return codemodMetaResults;
}

export default jscodemod;