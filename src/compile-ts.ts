import tempy from 'tempy';
import findUpDetailed from './find-up-detailed';
import loadJsonFile from 'load-json-file';
import {promises as fs} from 'fs';
import * as jsoncParser from 'jsonc-parser';
import path from 'path';
import type {TSOptions} from './';
import {cyan} from 'ansi-colors';
import execa from 'execa';
import findUp from 'find-up';

type PackageJson = {name: string};
const packageJson = loadJsonFile.sync(path.resolve(__dirname, '..', 'package.json')) as PackageJson;

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

  return tempy.directory({prefix: `${packageJson.name.replace('/', '-')}-ts-out-dir`});
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

async function compileTS(
  pathToCodemod: string,
  {tsconfig: specifiedTSConfig, tsOutDir: specifiedTSOutDir, tsc: specifiedTSC, log}: TSOptions
): Promise<string> {
  const tsconfigPath = await getTSConfigPath(pathToCodemod, specifiedTSConfig);
  const tsc = await getTSCPath(specifiedTSC);
  const tsOutDir = await getTSOutDir(specifiedTSOutDir);

  const tsconfig = jsoncParser.parse(await fs.readFile(tsconfigPath, 'utf-8'));
  const rootDir = tsconfig.compilerOptions?.rootDir;
  if (!rootDir) {
    const err = new Error('Your tsconfig must set compilerOptions.rootDir so jscodemod can find the compiled output.');
    Object.assign(err, {tsconfig});
    throw err;
  }

  const tscArgs = ['--project', tsconfigPath, '--outDir', tsOutDir];
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

  const resolvedRootDir = path.resolve(path.dirname(tsconfigPath), rootDir);
  const pathToCodemodJs = path.join(path.dirname(pathToCodemod), `${path.basename(pathToCodemod, '.ts')}.js`);
  const pathFromRootDirToCodemod = path.relative(resolvedRootDir, pathToCodemodJs);
  const compiledPath = path.join(tsOutDir, pathFromRootDirToCodemod);

  log.debug({
    resolvedRootDir,
    pathFromRootDirToCodemod,
    compiledPath
  }, 'Looking for compiled codemod JS at this path.');
  return compiledPath;
}

export default compileTS;