#!/usr/bin/env node

import yargs from 'yargs';
import codemod from './';
import _ from 'lodash';
import 'loud-rejection/register';
import createLogger from 'nth-log';
import PrettyError from 'pretty-error';

PrettyError.start();

const tsOnlyNote = '(Only applicable if your codemod is written in TypeScript)';

const argv = yargs
  .usage('$0 [options] <file globs>')
  // TODO: Some of these options should be hidden.
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
    },
    jsonOutput: {
      type: 'boolean',
      default: false,
      describe: 'Output logs as JSON, instead of human-readable formatting. Useful if you want to consume the output ' +
        ' of this tool from another tool, or process the logs using your own Bunyan log processor/formatter.'
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

async function main() {
  // This type is not flowing properly from createLogger.
  const logOpts: {name: string; stream?: unknown} = {name: 'jscodemod-coordinator'};
  if (argv.jsonOutput) {
    logOpts.stream = process.stdout;
  }
  const log = createLogger(logOpts);

  // This is not an exhaustive error wrapper, but I think it's ok for now. Making it catch more cases would introduce
  // complexity without adding much safety.
  try {
    await codemod(
      argv.codemod, 
      argv._, 
      {
        ..._.pick(argv, 'tsconfig', 'tsOutDir', 'tsc', 'dry', 'ignoreNodeModules', 'resetDirtyInputFiles'),
        log
      }
    );
  } catch (err) {
    // TODO: Maybe known errors should be marked with a flag, since showing a stack trace for them probably
    // is just noise.
    log.fatal({err});
    // This is intentional.
    // eslint-disable-next-line no-console
    console.log(new PrettyError().render(err));
    log.info("If you need help, please see this project's README, or the --help output.");
    process.exit(1);
  }
}

main();