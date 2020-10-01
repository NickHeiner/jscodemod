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

const noOpLogger = createLog({name: 'no-op', stream: fs.createWriteStream('/dev/null')});

export type Options = {
  tsconfig?: string;
  tsOutDir?: string
  tsc?: string;
  dry?: boolean;
  porcelain?: boolean;
  resetDirtyInputFiles?: boolean;
  log?: ReturnType<typeof createLog>
}

// The rule is too broad.
// eslint-disable-next-line require-await
async function getCodemodPath(pathToCodemod: string, options: Options, log: TODO) {
  if (pathIsTS(pathToCodemod)) {
    return compileTS(pathToCodemod, options, log);
  }

  return path.resolve(pathToCodemod);
}

async function transformCode(codemodPath: string, inputFiles: string[]) {
  const piscina = new Piscina({
    filename: require.resolve('./worker'),
    argv: [codemodPath],
    workerData: {codemodPath}
  });

  const progressBar = new ProgressBar(':bar (:current/:total, :percent%)', {total: inputFiles.length});
  await Promise.all(inputFiles.map(async inputFile => {
    await piscina.runTask(inputFile);
    progressBar.tick();
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
  pathToCodemod: string, inputFilesPatterns: string[], {log = noOpLogger, ...options}: Options
): Promise<void | string[]> {
  const codemodPath = await getCodemodPath(pathToCodemod, _.pick(options, 'tsconfig', 'tsOutDir', 'tsc'), log);
  log.debug({codemodPath});

  const codemod = loadCodemod(codemodPath);
  const inputFilePatternsWithIgnores = [
    ...inputFilesPatterns, 
    ...(codemod.ignore || []).map(pattern => `!${pattern}`)
  ];
  const filesToModify = (await globby(inputFilePatternsWithIgnores, {dot: true, gitignore: true}))
    .map(filePath => path.resolve(filePath));
  if (!filesToModify.length) {
    const err = new Error('No files were found to transform.');
    Object.assign(err, {inputFilePatternsWithIgnores});
    throw err;
  }

  const logMethod = options.dry ? 'info' : 'debug';
  log[logMethod](
    {filesToModify, count: filesToModify.length, inputFilePatternsWithIgnores}, 
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
    resetDirtyInputFiles(gitRoot, filesToModify, log);
  }
  
  await transformCode(codemodPath, filesToModify);
}

export default codemod;