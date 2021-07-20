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
import fs from 'fs';
import compileTS from './compile-ts';
import {TODO} from './types';
import execBigCommand from './exec-big-command';
import getGitRoot from './get-git-root';
import loadCodemod from './load-codemod';
import {CodemodMetaResult} from './worker';
import gitignore from './gitignore';
import getCodemodName from './get-codemod-name';

export {default as getTransformedContentsOfSingleFile} from './get-transformed-contents-of-single-file';

const noOpLogger = createLog({name: 'no-op', stream: fs.createWriteStream('/dev/null')});

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
}

export type Options = Omit<TSOptions, 'log'> & Partial<Pick<TSOptions, 'log'>> & NonTSOptions;

type FalseyDefaultOptions = 'dry' | 'porcelain' | 'codemodArgs' | 'resetDirtyInputFiles' | 'jsonOutput';
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

function transformCode(codemodPath: string, inputFiles: string[], writeFiles: boolean,
  logOpts: Pick<Options, 'porcelain' | 'jsonOutput'>, codemodArgs?: string[]) {

  const rawArgs = codemodArgs ? JSON.stringify(codemodArgs) : undefined;
  const piscina = new Piscina({
    filename: require.resolve('./worker'),
    argv: [codemodPath],
    workerData: {codemodPath, codemodArgs: rawArgs, writeFiles, logOpts}
  });

  const progressBar = getProgressUI(logOpts, inputFiles.length);
  return Promise.all(inputFiles.map(async inputFile => {
    const codemodMetaResult: CodemodMetaResult = await piscina.runTask(inputFile);
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

  log.debug({
    codemodName,
    inputFilesPatterns,
    // Workaround for https://github.com/NickHeiner/nth-log/issues/12.
    codemodIgnores: codemodIgnores.map(re => re.toString()),
    codemodIgnoreFiles: codemod.ignoreFiles
  }, 'Globbing input file patterns.');
  const filesToModify = _((await globby(inputFilesPatterns, {dot: true, gitignore: true})))
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

  const codemodMetaResults = await transformCode(codemodPath, filesToModify, writeFiles,
    _.pick(passedOptions, 'jsonOutput', 'porcelain'), options.codemodArgs
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