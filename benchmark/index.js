#! /usr/bin/env node

const _ = require('lodash');
const yargs = require('yargs');
const path = require('path');
const benchmark = require('benchmark');
const resolveBin = require('resolve-bin');
const {promisify} = require('util');
const execa = require('execa');
const envInfo = require('envinfo');
const packageJson = require('../package');
const CliTable = require('cli-table3');
const createLogger = require('nth-log').default;
const PrettyError = require('pretty-error');
require('loud-rejection/register');

PrettyError.start();

const log = createLogger({name: 'benchmark'});

const resolveBinP = promisify(resolveBin);

/**
 * To make this script's results more accurate:
 *  1. Provide a robust mechanism to ensure that the set of input files are the same.
 *  2. Provide a way to run more samples.
 *  3. Protect against the issue of the machine's environment changing between different suite runs. (For instance,
 *        if you run this locally, and during one suite, you're doing nothing else on your machine, and on the next
 *        suite, you launch a bitcoin miner, that will make the comparison invalid.)
 *  4. In the output, include environment info (OS, Node version, hardware configuration, background utilization levels)
 *
 * Also, this will make a lot of spammy output on the console. Sorry.
 */

const {argv} = yargs
  .strict()
  .usage('$0 <repoToTransform>', 'Run the benchmark against a repo', yargs => {
    yargs.positional('repoToTransform', {
      type: 'string',
      describe: 'An absolute path to a repo to run against'
    });
  })
  .options({
    testRun: {
      type: 'boolean',
      describe: 'Instead of running the benchmark, run each benchmarked command against the input repo. ' +
      'This verifies that the codemods work. This is also useful to ensure that each benchmarked command is running ' +
      'against the same set of input files. If commands are running against different input sets, then the ' +
      'comparison will be invalid.'
    }
  })
  .help();

async function runBenchmarks() {
  const {repoToTransform} = argv;
  const execInRepo = (binPath, args, opts) => {
    log.debug({binPath, args, fullCommand: `${binPath} ${args.join(' ')}`});
    execa.sync(binPath, args, {...opts, cwd: repoToTransform, env: {
      SILENT: 'true'
    }});
  };

  log.info('For a valid comparison, make sure that both codemods run on the same set of input files.');

  const resetChanges = async silent => {
    if (!silent) {
      log.warn({repoToTransform}, `Resetting uncommited changes in ${repoToTransform}.`);
    }
    await execInRepo('git', ['restore', '.']);
  };

  const pathFromRepoRoot = (...pathParts) => path.resolve(__dirname, '..', ...pathParts);
  const binPath = pathFromRepoRoot(packageJson.bin);
  const jscodeshiftBinPath = await resolveBinP('jscodeshift', {executable: 'jscodeshift'});

  // Possible source of error: the input file patterns passed to each codemod tool return different sets of files.
  //
  // You may need to hit control+c multiple times to kill this script. I thought execa was supposed to propagate that
  // and automatically kill child processes, but maybe that doesn't work as well with .sync?
  const jscodemodString = execOpts => execInRepo(
    binPath,
    [
      '--codemod', pathFromRepoRoot('fixtures', 'prepend-string', 'codemod', 'codemod.js'),
      '**/*.{js,ts,tsx}'
    ],
    execOpts
  );
  const jscodeshiftString = execOpts => execInRepo(
    jscodeshiftBinPath,
    [
      '--no-babel',
      '--transform', pathFromRepoRoot('fixtures', 'prepend-string', 'codemod', 'jscodeshift-codemod.js'),
      '--extensions', 'js,ts,tsx',
      '--ignore-pattern', 'node_modules',
      '.'
    ],
    execOpts
  );

  const jscodemodBabelPiscina = execOpts => execInRepo(
    binPath,
    [
      '--piscinaLowerBoundInclusive', '1',
      '--codemod', pathFromRepoRoot('fixtures', 'return-meta-from-plugin', 'codemod.js'),
      '**/*.{js,ts,tsx}'
    ],
    execOpts
  );

  const jscodemodBabelSingleThread = execOpts => execInRepo(
    binPath,
    [
      '--piscinaLowerBoundInclusive', String(Number.MAX_SAFE_INTEGER),
      '--codemod', pathFromRepoRoot('fixtures', 'return-meta-from-plugin', 'codemod.js'),
      '**/*.{js,ts,tsx}'
    ],
    execOpts
  );

  if (argv.testRun) {
    await resetChanges();
    jscodemodString({stdio: 'inherit'});
    await resetChanges();
    jscodeshiftString({stdio: 'inherit'});
    await resetChanges();
    jscodemodBabelPiscina({stdio: 'inherit'});
    await resetChanges();
    jscodemodBabelSingleThread({stdio: 'inherit'});
    return;
  }

  const codemodBenchmark = benchmark.Suite({
    setup: resetChanges
  });

  const envInfoMd = await envInfo.run({
    System: ['OS', 'CPU'],
    Binaries: ['Node']
  }, {markdown: true});

  codemodBenchmark
    .add('jscodemod#string', () => {
      jscodemodString({stdio: 'inherit'});
    })
    .add('jscodeshift#string', () => {
      jscodeshiftString({stdio: 'inherit'});
    })
    .add('jscodemod#babelPiscina', () => {
      jscodemodBabelPiscina({stdio: 'inherit'});
    })
    .add('jscodemod#babelSingleThread', () => {
      jscodemodBabelSingleThread({stdio: 'inherit'});
    })
    .on('complete', arg => {
      // This is brittle, but something more robust might be more complexity than it's worth, given Benchmark's API.
      const jscodemodStringStats = arg.currentTarget[0].stats;
      const jscodeshiftStringStats = arg.currentTarget[1].stats;
      const jscodemodBabelPiscinaStats = arg.currentTarget[2].stats;
      const jscodemodBabelSingleThreadStats = arg.currentTarget[3].stats;

      // TODO: It would actually be nicer to render markdown, so it can easily paste into the docs.
      const makeTable = () => new CliTable({
        head: ['Runner', 'Transform', 'Mean Duration (seconds)', 'Standard Deviation (seconds)', 'Sample count']
      });

      const stringTable = makeTable();
      const babelTable = makeTable();

      // eslint-disable-next-line no-magic-numbers
      const significantDigits = number => number.toPrecision(3);

      const addTableEntry = (table, runnerName, transformName, stats) =>
        table.push([
          runnerName, transformName, significantDigits(stats.mean), significantDigits(stats.deviation),
          stats.sample.length
        ]);

      addTableEntry(stringTable, 'jscodemod', 'string', jscodemodStringStats);
      addTableEntry(stringTable, 'jscodeshift', 'string', jscodeshiftStringStats);
      addTableEntry(babelTable, 'jscodemod', 'babelPiscina', jscodemodBabelPiscinaStats);
      addTableEntry(babelTable, 'jscodemod', 'babelSingleThread', jscodemodBabelSingleThreadStats);

      // This is intentional.
      // eslint-disable-next-line no-console
      console.log(stringTable.toString());
      // eslint-disable-next-line no-console
      console.log(babelTable.toString());
      // eslint-disable-next-line no-console
      console.log(envInfoMd);
    })
    .run();
}

runBenchmarks();
