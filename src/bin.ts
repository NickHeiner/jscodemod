#!/usr/bin/env node

import yargs from 'yargs';
import codemod from './';
import _ from 'lodash';
import 'loud-rejection/register';
import createLogger from 'nth-log';
import fs from 'fs';

const tsOnlyNote = '(Only applicable if your codemod is written in TypeScript)';

// Passing paths as file globs that start with `.` doesn't work.
// https://github.com/sindresorhus/globby/issues/168

const {argv} = yargs
  // TODO: Some of these options should be hidden.
  .command(
    '$0 [options] <fileGlobs...>', 
    'Run the codemod. Any arguments after "--" will be passed through to the codemod.', 
    yargs => {
      yargs.positional('fileGlobs', {
        required: true,
        type: 'string'
      });
    })
  .middleware(argv => {
    argv.codemodArgs = argv['--'];
    return argv;
  }, true)
  .options({
    codemod: {
      alias: 'c',
      type: 'string',
      required: true,
      describe: 'Path to the codemod to run'
    },
    // TODO: allow arbitrary TS arg passthrough at your own risk.
    tsconfig: {
      type: 'string',
      describe: `${tsOnlyNote} path to the tsconfig.json`
    },
    // I'm going to skip adding tests for this for now, because I'm not sure it's actually necessary.
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
    // Does this really need to exist when we have jsonOutput?
    porcelain: {
      alias: 'p',
      default: false,
      type: 'boolean',
      describe: 'Produce machine-readable output.'
    },
    codemodArgs: {
      type: 'string',
      hidden: true,
      describe: 'Do not pass this argument. This is only here to make yargs happy.'
    },
    resetDirtyInputFiles: {
      alias: 'r',
      type: 'boolean',
      default: false,
      describe: 'Use git to restore dirty files to a clean state before running the codemod. ' +
        'This assumes that all input files have the same .git root. If you use submodules, this may not work.'
    },
    jsonOutput: {
      type: 'boolean',
      default: false,
      describe: 'Output logs as JSON, instead of human-readable formatting. Useful if you want to consume the output ' +
        ' of this tool from another tool, or process the logs using your own Bunyan log processor/formatter.'
    },
    watch: {
      alias: 'w',
      type: 'boolean',
      describe: 'Interactive watch mode. Defaults to "true" for detectors and "false" for transformers.'
    }
  })
  .group(['codemod', 'dry', 'resetDirtyInputFiles'], 'Primary')
  .group(['tsconfig', 'tsOutDir', 'tsc'], 'TypeScript')
  .group(['jsonOutput', 'porcelain', 'watch'], 'Rarely Useful')
  .check(argv => {
    // Yarg's types are messed up.
    // @ts-expect-error
    if (!argv.fileGlobs.length) {
      throw new Error('You must pass at least one globby pattern of files to transform.');
    }
    if (argv.porcelain && !argv.dry) {
      throw new Error('Porcelain is only supported for dry mode.');
    }
    return true;
  })
  .strict()
  .help();

async function main() {
  // This type is not flowing properly from createLogger.
  const logOpts: {name: string; stream?: unknown} = {name: 'jscodemod-coordinator'};
  if (argv.jsonOutput) {
    logOpts.stream = process.stdout;
  }
  if (argv.porcelain) {
    logOpts.stream = fs.createWriteStream('/dev/null');
  }
  const log = createLogger(logOpts);

  log.debug({argv});

  // This is not an exhaustive error wrapper, but I think it's ok for now. Making it catch more cases would introduce
  // complexity without adding much safety.
  try {
    const opts = {
      ..._.pick(argv, 'tsconfig', 'tsOutDir', 'tsc', 'dry', 'resetDirtyInputFiles', 'porcelain', 'watch'),
      log
    };

    // Yarg's types are messed up.
    Object.assign(opts, _.pick(argv, 'codemodArgs'));

    await codemod(
      argv.codemod, 
      // Yarg's types are messed up.
      // @ts-expect-error
      argv.fileGlobs, 
      opts
    );
  } catch (err) {
    // TODO: Maybe known errors should be marked with a flag, since showing a stack trace for them probably
    // is just noise.
    log.fatal({err});
    if (!argv.jsonOutput) {
      // This is intentional.
      // eslint-disable-next-line no-console
      console.log(err);
    }
    log.info("If you need help, please see this project's README, or the --help output. " + 
      "If you're filing a bug report, please re-run this command with env var 'loglevel=debug', and provide the " + 
      'full output.');
    process.exit(1);
  }
}

main();