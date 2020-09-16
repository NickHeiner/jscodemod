import globby from 'globby';
import {promisify} from 'util';
import resolveBin from 'resolve-bin';
import tempy from 'tempy';
import execa from 'execa';
import log from 'nth-log';
import pathIsTS from './path-is-ts';

// In this case, load-json-file is overkill.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const packageJson = require('../package');

const resolveBinP = promisify(resolveBin);

type Options = {
  tsconfig?: string;
  tsOutDir?: string;
  tsc?: string;
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

async function compileTS({tsconfig, tsOutDir: specifiedTSOutDir, tsc: specifiedTSC}: Options) {
  if (!tsconfig) {
    throw new Error('If your codemod is TypeScript, option "tsconfig" is required.');
  }

  const tsc = await getTSCPath(specifiedTSC);
  const tsOutDir = await getTSOutDir(specifiedTSOutDir);

  const tscArgs = ['--project', tsconfig, '--outDir', tsOutDir];
  log.debug({tsc, tscArgs}, 'exec');
  await execa(tsc, tscArgs);
}


async function codemod(pathToCodemod: string, inputFilesPatterns: string[], options: Options): Promise<void> {
  const inputFiles = await globby(inputFilesPatterns);
  log.debug({inputFiles});

  if (pathIsTS(pathToCodemod)) {
    await compileTS(options);
  }
}


export default codemod;