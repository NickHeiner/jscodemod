#!/usr/bin/env node

import yargs from 'yargs';
import codemod from './';
import _ from 'lodash';

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
      alias: 'tsc',
      type: 'string',
      describe: "path to the tsconfig.json to use to compile your codemod, if it's written in TypeScript."
    }
  })
  .help()
  .argv;

codemod(argv.codemod, argv._, _.pick(argv, 'tsconfig'));