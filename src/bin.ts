#!/usr/bin/env node

import yargs from 'yargs';
import codemod from './';
import _ from 'lodash';
import 'loud-rejection/register';
import getLogger from './get-logger';

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
    // If the input files glob points to the codemod, will this reset the codemod?
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
    // If the input files glob points to the codemod, and the codemod modifies itself, 
    // could it trigger an infinite loop?
    watch: {
      alias: 'w',
      type: 'boolean',
      describe: 'Interactive watch mode. Defaults to "true" for detectors and "false" for transformers.'
    }
  })
  .group(['codemod', 'dry', 'resetDirtyInputFiles'], 'Primary')
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
  const log = getLogger(_.pick(argv, 'jsonOutput', 'porcelain'));
  log.debug({argv});

  // This is not an exhaustive error wrapper, but I think it's ok for now. Making it catch more cases would introduce
  // complexity without adding much safety.
  try {
    const opts = {
      // Yarg's types are messed up.
      inputFilePatterns: argv.fileGlobs as string[],
      inputFiles: [] as string[],
      ..._.pick(argv, 'dry', 'resetDirtyInputFiles', 'porcelain', 'watch'),
      log
    };

    // Yarg's types are messed up.
    Object.assign(opts, _.pick(argv, 'codemodArgs'));

    await codemod(
      argv.codemod, 
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