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
  ignoreNodeModules?: boolean;
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
  pathToCodemod: string, inputFilesPatterns: string[], {ignoreNodeModules = true, log = noOpLogger, ...options}: Options
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
  
  async function getGitRoot(inputFilesPaths: string[]): Promise<string> {
    // Assume that all files are in the same .git root, and there are no submodules.
    const arbitraryFilePath = path.dirname(inputFilesPaths[0]);
    const gitDir = await findUp('.git', {cwd: arbitraryFilePath, type: 'directory'});
    if (!gitDir) {
      throw new Error(`Could not find the git root for ${cyan(arbitraryFilePath)}.`);
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

  const finalPatterns = [...inputFilesPatterns];
  if (ignoreNodeModules) {
    inputFilesPatterns.forEach(filePattern => {
      /**
       * If the input file path is something like "../foo", then we need to pass the glob pattern "!../node_modules"
       * to ignore it. This is fairly simple to do (scan all the input file paths, and construct one or more 
       * exclusion globs as needed), but I'd rather save on the complexity until someone asks for this to work.
       */
      const resolvedPattern = path.resolve(filePattern);
      if (!resolvedPattern.startsWith(process.cwd())) {
        throw new Error(
          'The automatic ignoreNodeModules option only works when all the input file patterns point to files that ' +
          `are contained within the current working directory (${cyan(process.cwd())}). However, input pattern ` +
          `${cyan(filePattern)} resolved to ${cyan(resolvedPattern)}, which is not contained within the current ` +
          `working directory. To resolve this, set ${cyan('ignoreNodeModules')} to false, and manually pass your own ` +
          `globby exclude pattern. For instance, if your input file pattern was ${cyan('../foo')}, you would need ` +
          `${cyan('!../**/node_modules')}.`
        );
      }
    });
    finalPatterns.push('!**/node_modules');
  }
  const inputFiles = (await globby(finalPatterns)).map(filePath => path.resolve(filePath));
  const logMethod = options.dry ? 'info' : 'debug';
  log[logMethod]({inputFiles, count: inputFiles.length, finalPatterns}, 'Input file pattern matched these files.');

  if (!inputFiles.length) {
    const err = new Error('No files were found to transform.');
    Object.assign(err, {finalPatterns});
    throw err;
  }

  if (options.dry) {
    log.info('Exiting early because "dry" was set.');
    return inputFiles;
  }

  if (options.resetDirtyInputFiles) {
    const gitRoot = await getGitRoot(inputFiles);
    log.debug({gitRoot});

    const modifiedFiles = (await execGit(gitRoot, ['status', '--porcelain'])).stdout.split('\n')
      // This assumes that none of the file paths have spaces in them.
      // It would be better to just split on the first ' ' we see.
      .map(line => line.trim().split(' '))
      .filter(([statusCode]) => statusCode === 'M')
      .map(([_statusCode, filePath]) => path.join(gitRoot, filePath));

    const modifiedInputFiles = _.intersection(modifiedFiles, inputFiles);
    log.debug({modifiedInputFiles, count: modifiedInputFiles.length});

    if (modifiedInputFiles.length) {
      const spinner = 
        ora(`Restoring ${cyan(modifiedInputFiles.length.toString())} dirty files to a clean state.`).start();
      await execBigCommand(['restore', '--staged'], modifiedInputFiles, (args: string[]) => execGit(gitRoot, args));
      await execBigCommand(['restore'], modifiedInputFiles, (args: string[]) => execGit(gitRoot, args));
      spinner.succeed();
    }
  }
  
  const codemodPath = await getCodemodPath(pathToCodemod, _.pick(options, 'tsconfig', 'tsOutDir', 'tsc'));
  log.debug({codemodPath});
  
  await transformCode(codemodPath, inputFiles);
}

export default codemod;