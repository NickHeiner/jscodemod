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
import compileTS, {TSOptions} from './compile-ts';
import {CliUi, CodemodKind, InternalOptions, NonTSOptions, Options, TODO} from './types';
import execBigCommand from './exec-big-command';
import getGitRoot from './get-git-root';
import loadCodemod from './load-codemod';
import type {CodemodMetaResult, DebugMeta, DetectMeta, ErrorMeta} from './worker';
import makeInteractiveUI, {DetectResults} from './make-interactive-ui';
import chokidar from 'chokidar';
import {AbortController} from 'abortcontroller-polyfill/dist/abortcontroller';

export {default as getTransformedContentsOfSingleFile} from './get-transformed-contents-of-single-file';

export {Codemod} from './types';

const devNull = fs.createWriteStream('/dev/null');
const noOpLogger = createLog({name: 'no-op', stream: devNull});

// The rule is too broad.
// eslint-disable-next-line require-await
async function getCodemodPath(pathToCodemod: string, options: TSOptions) {
  if (pathIsTS(pathToCodemod)) {
    return compileTS(pathToCodemod, options);
  }

  return path.resolve(pathToCodemod);
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

// TODO: Export this as test-only, or put it in its own file, so it is not being exported
// from the main export.
export function getWatch(codemodKind: CodemodKind, watch: NonTSOptions['watch']): boolean {
  const isTransformCodemod = codemodKind === 'transform';
  if (isTransformCodemod && watch) {
    throw new Error('Watch mode is not supported for transform codemods.');
  }
  
  return isTransformCodemod ? false : !(watch === false);
}

async function codemod(
  pathToCodemod: string, 
  inputFilesPatterns: string[], 
  passedOptions: Options = {}
): Promise<CodemodMetaResult[] | string[] | undefined> { 
  // TODO: encode that this return type depends on whether 'dry' is passed.
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

  async function runCodemod({
    codemodPath, inputFiles, writeFiles, codemodArgs, codemodKind, abortSignal, onProgress
  }: {
    codemodPath: string;
    inputFiles: string[]; 
    writeFiles: boolean; 
    codemodArgs?: string;
    codemodKind: CodemodKind;
    abortSignal: AbortSignal;
    onProgress?: (filesScanned: number) => void;
  }) {
    const isTransformCodemod = codemodKind === 'transform';
  
    const piscina = new Piscina({
      filename: require.resolve('./worker'),
      argv: [codemodPath],
      workerData: {codemodPath, codemodArgs, writeFiles}
    });
  
    const progressBar = new ProgressBar(':bar (:current/:total, :percent%)', {
      total: inputFiles.length,
      stream: isTransformCodemod ? undefined : devNull
    });
  
    let filesScanned = 0;
    const codemodResults = await Promise.all(inputFiles.map(async inputFile => {
      if (abortSignal.aborted) {
        return 'aborted';
      }
      const codemodMetaResult: CodemodMetaResult = await piscina.runTask(inputFile);
      log.debug({
        ...codemodMetaResult,
        fileContents: '<truncated file contents>'
      });
      progressBar.tick();
      onProgress?.(++filesScanned);
      return codemodMetaResult;
    }));
    if (abortSignal.aborted || codemodResults.some(value => value === 'aborted')) {
      return 'aborted';
    }
  
    return codemodResults as CodemodMetaResult[];
  }

  function watchFileOrDoOnce<T>(
    filePath: string, watch: boolean, onChange: (abortSignal: AbortSignal) => Promise<T | undefined>
  ): Promise<T | undefined> {
    if (watch) {
      log.debug({filePath}, 'watching');

      let abortController = new AbortController();
      const onWatcherChange = () => {
        abortController.abort();
        abortController = new AbortController();
        onChange(abortController.signal);
      };

      chokidar.watch(filePath)
        .on('ready', () => {
          log.debug({filePath}, 'watcher ready');
          onWatcherChange();
        })
        .on('change', onWatcherChange);

      return new Promise(() => {});
    }

    return onChange(new AbortController().signal);
  }

  async function compileAndLoadCodemod() {
    const codemodPath = await getCodemodPath(pathToCodemod, {
      ..._.pick(options, 'tsconfig', 'tsOutDir', 'tsc'),
      log
    });
    
    const codemod = loadCodemod(codemodPath);
    log.debug({codemodPath, codemodKeys: Object.keys(codemod)});

    return {codemod, codemodPath};
  }

  const {codemod} = await compileAndLoadCodemod();

  const codemodKind = codemod.detect ? 'detect' : 'transform';
  const watch = getWatch(codemodKind, options.watch);

  const staticUI: CliUi = {
    showReacting() {},
    showDetectResults(detectResults: DetectResults) {
      log.info({detectResults, counts: _.mapValues(detectResults.byLabel, 'length')});
    },
    showDebug(debugEntriesPerFile) {
      _.forEach(debugEntriesPerFile, (debugEntries, file) => {
        log.info({file, debugEntries});
      });
    }
  };
  const ui = watch ? makeInteractiveUI() : staticUI;
  
  return watchFileOrDoOnce(pathToCodemod, watch, async (abortSignal: AbortSignal) => {
    if (abortSignal.aborted) { 
      return; 
    }
    ui.showReacting(0, 0);
    const {codemodPath, codemod} = await compileAndLoadCodemod();
    if (abortSignal.aborted) { 
      return; 
    }

    // The next line is a bit gnarly to make TS happy.
    const codemodIgnores = _.compact(([] as (RegExp | undefined)[]).concat(codemod.ignore));

    log.debug({inputFilesPatterns}, 'Globbing input file patterns.');
    const filesToModify = _((await globby(inputFilesPatterns, {dot: true, gitignore: true})))
      .map(filePath => path.resolve(filePath))
      .reject(filePath => _.some(codemodIgnores, ignorePattern => ignorePattern.test(filePath)))
      .value();
    
    if (abortSignal.aborted) { 
      return; 
    }

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
    ui.showReacting(0, filesToModify.length);

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
    await codemod.parseArgs?.(options.codemodArgs);
    process.off('exit', handleExit);
    if (abortSignal.aborted) { 
      return; 
    }

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
    if (abortSignal.aborted) { 
      return; 
    }
    log.debug({gitRoot});

    if (options.resetDirtyInputFiles) {
      await resetDirtyInputFiles(gitRoot, filesToModify, log);
      if (abortSignal.aborted) { 
        return; 
      }
    }

    const codemodMetaResults = await runCodemod({
      codemodPath, 
      inputFiles: filesToModify, 
      writeFiles,
      codemodKind: codemod.detect ? 'detect' : 'transform',
      ..._.pick(options, 'codemodArgs'),
      abortSignal,
      onProgress(filesScanned) {
        ui.showReacting(filesScanned, filesToModify.length);
      }
    });
    if (codemodMetaResults === 'aborted' || abortSignal.aborted) { 
      return; 
    }

    const getRelativeFilePath = (absoluteFilePath: string) => 
      gitRoot ? path.relative(gitRoot, absoluteFilePath) : absoluteFilePath;

    const debug = _.filter(codemodMetaResults, 'debugEntries');
    if (debug.length) {
      ui.showDebug(
        _((debug as DebugMeta[]))
          .keyBy('filePath')
          .mapKeys((_val, filePath) => getRelativeFilePath(filePath))
          .mapValues('debugEntries')
          .value()
      );
    }

    if ('postProcess' in codemod && doPostProcess) {
      const modifiedFiles = _(codemodMetaResults).filter('codeModified').map('filePath').value();
      await log.logPhase({
        phase: 'postProcess',
        modifiedFiles,
        loglevel: 'debug'
        // This non-null assertion is safe because if we verififed above that `postProcess` is defined, it will not
        // have been undefined by the time this executes.
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      }, () => codemod.postProcess!(modifiedFiles));
      if (abortSignal.aborted) { 
        return; 
      }
    }

    if (codemodKind === 'detect' && !debug.length) {
      const [errored, labelled] = _.partition(codemodMetaResults as (DetectMeta | ErrorMeta)[], 'error');
      const getFilePaths = (files: (DetectMeta | ErrorMeta)[]) => 
        _.map(files, ({filePath}) => getRelativeFilePath(filePath));

      const byLabel = _(labelled)
        .groupBy('label')
        .mapValues(getFilePaths)
        .value();

      ui.showDetectResults({
        byLabel,
        errored: _(errored).keyBy('filePath').mapValues('error').value()
      });
    }

    return codemodMetaResults;
  });

}

export default codemod;