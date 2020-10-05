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
  codemodArgs?: string;
  resetDirtyInputFiles?: boolean;
  doPostProcess?: boolean;
}

export type Options = Omit<TSOptions, 'log'> & Partial<Pick<TSOptions, 'log'>> & NonTSOptions;

type FalseyDefaultOptions = 'dry' | 'porcelain' | 'codemodArgs' | 'resetDirtyInputFiles';
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

function transformCode(codemodPath: string, inputFiles: string[], writeFiles: boolean, codemodArgs?: string) {
  const piscina = new Piscina({
    filename: require.resolve('./worker'),
    argv: [codemodPath],
    workerData: {codemodPath, codemodArgs, writeFiles}
  });

  const progressBar = new ProgressBar(':bar (:current/:total, :percent%)', {total: inputFiles.length});
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

async function codemod(
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
    ...passedOptions
  };

  const codemodPath = await getCodemodPath(pathToCodemod, {
    ..._.pick(options, 'tsconfig', 'tsOutDir', 'tsc'),
    log
  });
  
  const codemod = loadCodemod(codemodPath);
  log.debug({codemodPath, codemod});
  
  // The next line is a bit gnarly to make TS happy.
  const codemodIgnores = _.compact(([] as (RegExp | undefined)[]).concat(codemod.ignore));

  const filesToModify = _((await globby(inputFilesPatterns, {dot: true, gitignore: true})))
    .map(filePath => path.resolve(filePath))
    .reject(filePath => _.some(codemodIgnores, ignorePattern => ignorePattern.test(filePath)))
    .value();

  if (!filesToModify.length) {
    const err = new Error('No files were found to transform.');
    Object.assign(err, {inputFilesPatterns});
    throw err;
  }

  const logMethod = options.dry ? 'info' : 'debug';
  log[logMethod](
    {filesToModify, count: filesToModify.length, inputFilesPatterns}, 
    'Found files to modify.'
  );

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
  log.debug({gitRoot});

  if (options.resetDirtyInputFiles) {
    await resetDirtyInputFiles(gitRoot, filesToModify, log);
  }
  
  const codemodMetaResults = await transformCode(codemodPath, filesToModify, writeFiles, options.codemodArgs);
  if (typeof codemod.postProcess === 'function' && doPostProcess) {
    const modifiedFiles = _(codemodMetaResults).filter('codeModified').map('filePath').value();
    await log.logPhase({
      phase: 'postProcess',
      modifiedFiles,
      loglevel: 'debug'
      // This non-null assertion is safe because if we verififed above that `postProcess` is defined, it will not
      // have been undefined by the time this executes.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    }, () => codemod.postProcess!(modifiedFiles));
  }
  return codemodMetaResults;
}

export default codemod;