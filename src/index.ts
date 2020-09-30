import globby from 'globby';
import _ from 'lodash';
import tempy from 'tempy';
import execa from 'execa';
import pathIsTS from './path-is-ts';
import path from 'path';
import findUp from 'find-up';
import findUpDetailed from './find-up-detailed';
import Piscina from 'piscina';
import ProgressBar from 'progress';
import {cyan} from 'ansi-colors';
import ora from 'ora';
import createLog from 'nth-log';
import fs from 'fs';
import loadJsonFile from 'load-json-file';

const noOpLogger = createLog({name: 'no-op', stream: fs.createWriteStream('/dev/null')});

// In this case, load-json-file is overkill.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const packageJson = require('../package');

type Options = {
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
async function getTSCPath(specifiedTSCPath?: string): Promise<string> {
  if (specifiedTSCPath) {
    return specifiedTSCPath;
  }

  // I originally wanted to use resolve-bin here, but that resolves from this file's location, which is not what
  // we want. We want to resolve from the codemod.
  const {foundPath: typescriptPath, checkedPaths} = await findUpDetailed(
    path.join('node_modules', 'typescript'), {type: 'directory'}
  );
  if (typescriptPath) {
    const tsPackageJsonPath = path.join(typescriptPath, 'package.json');
    const tsPackageJson = await loadJsonFile<{bin: {tsc: string}}>(tsPackageJsonPath);
    return path.join(typescriptPath, tsPackageJson.bin.tsc);
  }

  const err = new Error(
    "If you have a TypeScript codemod, and you don't specify a path to a 'tsc' executable that will " +
    "compile your codemod, then this tool searches in your codemod's node_modules. However, TypeScript could not be " +
    'found there either.'
  );
  Object.assign(err, {checkedPaths});
  throw err;
}

// The rule is too broad.
// eslint-disable-next-line require-await
async function getTSOutDir(specifiedTSOutDir?: string): Promise<string> {
  if (specifiedTSOutDir) {
    return specifiedTSOutDir;
  }

  return tempy.directory({prefix: `${packageJson.name}-ts-out-dir`});
}

async function getTSConfigPath(pathToCodemod: string, specifiedTSConfig?: string) {
  if (specifiedTSConfig) {
    return specifiedTSConfig;
  }

  const codemodDir = path.dirname(pathToCodemod);
  const {foundPath, checkedPaths} = await findUpDetailed('tsconfig.json', {cwd: codemodDir});

  if (!foundPath) {
    const err = new Error(
      `This tool was not able to find a ${cyan('tsconfig.json')} file by doing a find-up from ${cyan(codemodDir)}. ` +
      'Please manually specify a tsconfig file path.'
    );
    Object.assign(err, {checkedPaths});
    throw err;
  }

  return foundPath;
}

async function codemod(
  pathToCodemod: string, inputFilesPatterns: string[], {log = noOpLogger, ...options}: Options
): Promise<void | string[]> {
  async function compileTS(
    pathToCodemod: string, {tsconfig: specifiedTSConfig, tsOutDir: specifiedTSOutDir, tsc: specifiedTSC}: Options
  ): Promise<string> {
    const tscConfigPath = await getTSConfigPath(pathToCodemod, specifiedTSConfig);
    const tsc = await getTSCPath(specifiedTSC);
    const tsOutDir = await getTSOutDir(specifiedTSOutDir);
  
    const tscArgs = ['--project', tscConfigPath, '--outDir', tsOutDir];
    log.debug({tsc, tscArgs}, 'exec');
    await execa(tsc, tscArgs);
  
    const originalNodeModules = await findUp(
      'node_modules',
      {cwd: path.dirname(pathToCodemod), type: 'directory'}
    );
    // If this var is not defined, then it means that the codemod had no node_modules. This seems very unlikely, but I
    // suppose it's possible.
    if (originalNodeModules) {
      await execa('ln', ['-s', originalNodeModules, 'node_modules'], {cwd: tsOutDir});
    }
    log.debug({originalNodeModules}, 'Searched for original node_modules');
  
    return path.join(tsOutDir, path.dirname(pathToCodemod), `${path.basename(pathToCodemod, '.ts')}.js`);
  }
  
  // The rule is too broad.
  // eslint-disable-next-line require-await
  async function getCodemodPath(pathToCodemod: string, options: Options) {
    if (pathIsTS(pathToCodemod)) {
      return compileTS(pathToCodemod, options);
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
  
  type GetGitRootOptions = {throwOnNotFound: boolean};
  async function getGitRoot(inputFilesPaths: string[]): Promise<string>;
  async function getGitRoot(inputFilesPaths: string[], opts: GetGitRootOptions): Promise<string | null>;
  async function getGitRoot(inputFilesPaths: string[], opts?: GetGitRootOptions) {
    // Assume that all files are in the same .git root, and there are no submodules.
    const arbitraryFilePath = path.dirname(inputFilesPaths[0]);
    const gitDir = await findUp('.git', {cwd: arbitraryFilePath, type: 'directory'});
    if (!gitDir) {
      if (opts?.throwOnNotFound) {
        throw new Error(`Could not find the git root for ${cyan(arbitraryFilePath)}.`);
      }
      return null;
    }
    // We want to pop up a level, since we want a directory we can execute git from, and you can't execute git
    // from the .git directory itself.
    return path.resolve(gitDir, '..');
  }
  
  function execGit(gitRoot: string, args: string[]): Promise<execa.ExecaReturnValue> {
    return execa('git', args, {cwd: gitRoot});
  }
  
  const getShellArgMax = _.once(async () => parseInt((await execa('getconf', ['ARG_MAX'])).stdout));
  
  async function execBigCommand(
    constantArgs: string[], 
    variableArgs: string[], 
    execCommand: (args: string[]) => Promise<execa.ExecaReturnValue>
  ) {
    const combinedArgs = [...constantArgs, ...variableArgs];
    const commandLengthBytes = new TextEncoder().encode(combinedArgs.join(' ')).length;
    const shellArgMaxBytes = await getShellArgMax();
  
    /**
     * My understanding is that if the commandLengthBytes < shellArgMaxBytes, then we should be safe. However, 
     * experimentally, this was not true. I still saw E2BIG errors. I don't know if it's because I'm misinterpreting 
     * what results of TextEncoder and `ARG_MAX`. But, if I divide by 2, then it worked in my anecdotal testing.
     */
    if (commandLengthBytes > shellArgMaxBytes / 2) {
      log.debug({
        variableArgCount: variableArgs.length,
        variableArgLengthBytes: commandLengthBytes,
        shellArgMaxBytes
      }, 'Splitting command to avoid an E2BIG error.');
      const midpointIndex = variableArgs.length / 2;
      const firstHalfVariableArgs = variableArgs.slice(0, midpointIndex);
      const secondHalfVariableArgs = variableArgs.slice(midpointIndex);
  
      // It's probably safer to run in serial here. The caller may not expect their command to be parallelized.
      await execBigCommand(constantArgs, firstHalfVariableArgs, execCommand);
      await execBigCommand(constantArgs, secondHalfVariableArgs, execCommand);
    } else {
      await execCommand(combinedArgs);
    }
  }

  async function getFilesToModify() {
    const inputFiles = (await globby(inputFilesPatterns)).map(filePath => path.resolve(filePath));
    if (!inputFiles.length) {
      const err = new Error('No files were found to transform.');
      Object.assign(err, {inputFilesPatterns});
      throw err;
    }

    const gitRoot = await getGitRoot(inputFiles, {throwOnNotFound: false});
    
    log.debug({gitRoot});

    if (!gitRoot) {
      return {filesToModify: inputFiles};
    }

    const gitTrackedFiles = 
      (await execGit(gitRoot, ['ls-tree', '-r', '--name-only', 'head']))
        .stdout
        .trim()
        .split('\n')
        .map(filePath => path.join(gitRoot, filePath));
  
    return {
      filesToModify: _.intersection(inputFiles, gitTrackedFiles),
      gitRoot
    };
  }

  const codemodPath = await getCodemodPath(pathToCodemod, _.pick(options, 'tsconfig', 'tsOutDir', 'tsc'));
  log.debug({codemodPath});

  const {filesToModify, gitRoot} = await getFilesToModify();

  const logMethod = options.dry ? 'info' : 'debug';
  log[logMethod](
    {filesToModify, count: filesToModify.length, inputFilesPatterns}, 
    'Input file pattern matched these files.'
  );

  if (options.dry) {
    if (options.porcelain) {
      filesToModify.forEach(filePath => console.log(filePath));
    } else {
      log.info('Exiting early because "dry" was set.');
    }
    return filesToModify;
  }

  if (options.resetDirtyInputFiles) {
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
      await execBigCommand(['restore', '--staged'], dirtyInputFiles, (args: string[]) => execGit(gitRoot, args));
      await execBigCommand(['restore'], dirtyInputFiles, (args: string[]) => execGit(gitRoot, args));
      spinner.succeed();
    }
  }
  
  await transformCode(codemodPath, filesToModify);
}

export default codemod;