#!/usr/bin/env ts-node-script

import yargs from 'yargs';

yargs
  .options({
    codemod: {
      alias: 'c',
      type: 'string',
      describe: 'Path to the codemod to run'
    }
  })
  .positional('filePattern', {
    type: 'string',
    description: 'Glob pattern of the files to compile',
  })
  .help()
  .argv;
