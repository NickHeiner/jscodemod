#!/usr/bin/env node

import yargs from 'yargs';
import codemod from './';
import _ from 'lodash';
import 'loud-rejection/register';

const tsOnlyNote = '(Only applicable if your codemod is written in TypeScript)';

const argv = yargs
  .usage('$0 [options] <file globs>')
  .options({
    codemod: {
      alias: 'c',
      type: 'string',
      required: true,
      describe: 'Path to the codemod to run'
    },
    tsconfig: {
      type: 'string',
      describe: `${tsOnlyNote} path to the tsconfig.json`
    },
    tsOutDir: {
      type: 'string',
      describe: `${tsOnlyNote} directory in which to compile your codemod to. Defaults to a temporary directory.`
    },
    tsc: {
      type: 'string',
      describe: `${tsOnlyNote} path to a "tsc" executable to compile your codemod. ` +
       'Defaults to looking for a "tsc" bin accessible from the current working directory.'
    },
    dry: {
      alias: 'd',
      type: 'boolean',
      describe: 'Print a list of files to modify, then stop.'
    },
    ignoreNodeModules: {
      type: 'boolean',
      default: true,
      describe: 'If true, automatically filter out node_modules from the set of files to transform.'
    },
    resetDirtyInputFiles: {
      alias: 'r',
      type: 'boolean',
      default: false,
      describe: 'If true, use git to restore dirty files to a clean state before running the codemod. ' +
        'This assumes that all input files have the same .git root. If you use submodules, this may not work.'
    }
  })
  .check(argv => {
    if (!argv._.length) {
      throw new Error('You must pass at least one globby pattern of files to transform.');
    }
    return true;
  })
  .help()
  .argv;

codemod(
  argv.codemod, 
  argv._, 
  _.pick(argv, 'tsconfig', 'tsOutDir', 'tsc', 'dry', 'ignoreNodeModules', 'resetDirtyInputFiles')
);