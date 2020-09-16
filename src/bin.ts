#!/usr/bin/env node

import yargs from 'yargs';
import codemod from './';
import _ from 'lodash';
import pathIsTS from './path-is-ts';

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
    }
  })
  .check(argv => {
    if (pathIsTS(argv.codemod) && !argv.tsconfig) {
      throw new Error('Argument "tsconfig" is required if the codemod is written in TypeScript.')
    }
    return true;
  })
  .help()
  .argv;

codemod(argv.codemod, argv._, _.pick(argv, 'tsconfig', 'tsOutDir', 'tsc'));