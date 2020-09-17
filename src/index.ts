import globby from 'globby';
import _ from 'lodash';
import {promisify} from 'util';
import resolveBin from 'resolve-bin';
import tempy from 'tempy';
import execa from 'execa';
import log from 'nth-log';
import pathIsTS from './path-is-ts';
import path from 'path';
import findUp from 'find-up';
import Piscina from 'piscina';
import ProgressBar from 'progress';
import {cyan} from 'ansi-colors';

// In this case, load-json-file is overkill.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const packageJson = require('../package');

const resolveBinP = promisify(resolveBin);

type Options = {
  tsconfig?: string;
  tsOutDir?: string;
  tsc?: string;
  dry?: boolean;
  ignoreNodeModules?: boolean;
  resetDirtyInputFiles?: boolean;
}

// The rule is too broad.
// eslint-disable-next-line require-await
async function getTSCPath(specifiedTSCPath?: string): Promise<string> {
  if (specifiedTSCPath) {
    return specifiedTSCPath;
  }

  return resolveBinP('typescript', {executable: 'tsc'});
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
  const foundPath = await findUp('tsconfig.json', {cwd: codemodDir});

  if (!foundPath) {
    throw new Error(
      `This tool was not able to find a ${cyan('tsconfig.json')} file by doing a find-up from ${cyan(codemodDir)}. ` +
      'Please manually specify a tsconfig file path.'
    );
  }

  return foundPath;
}

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
    // async dir => findUp.exists(path.join(dir, 'node_modules')), 
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

async function execGit(gitRoot: string, args: string[]): Promise<execa.ExecaReturnValue> {
  return execa('git', args, {cwd: gitRoot});
}

async function codemod(
  pathToCodemod: string, inputFilesPatterns: string[], {ignoreNodeModules = true, ...options}: Options
): Promise<void | string[]> {
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
  const inputFiles = (await globby(inputFilesPatterns)).map(filePath => path.resolve(filePath));
  const logMethod = options.dry ? 'info' : 'debug';
  log[logMethod]({inputFiles, count: inputFiles.length}, 'Input file pattern matched these files.');

  if (options.dry) {
    log.info('Exiting early because "dry" was set.');
    return inputFiles;
  }

  if (options.resetDirtyInputFiles) {
    const gitRoot = await getGitRoot(inputFiles);
    log.debug({gitRoot});

    const modifiedFiles = (await execGit(gitRoot, ['status', '--porcelain'])).stdout.split('\n')
      .map(line => line.trim().split(' '))
      .filter(([statusCode]) => statusCode === 'M')
      .map(([_statusCode, filePath]) => path.join(gitRoot, filePath));

    const modifiedInputFiles = _.intersection(modifiedFiles, inputFiles);
    log.debug({modifiedInputFiles, count: modifiedInputFiles.length});

    await execGit(gitRoot, ['restore', '--staged', ...modifiedFiles]);
    await execGit(gitRoot, ['restore', ...modifiedFiles]);
  }
  
  const codemodPath = await getCodemodPath(pathToCodemod, _.pick(options, 'tsconfig', 'tsOutDir', 'tsc'));
  log.debug({codemodPath});
  
  await transformCode(codemodPath, inputFiles);
}

export default codemod;