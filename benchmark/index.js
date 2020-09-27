#! /usr/bin/env node

const _ = require('lodash');
const yargs = require('yargs');
const path = require('path');
const benchmark = require('benchmark');
const resolveBin = require('resolve-bin');
const {promisify} = require('util');
const execa = require('execa');
const packageJson = require('../package');
const CliTable = require('cli-table3');
const createLogger = require('nth-log').default;
const PrettyError = require('pretty-error');
require('loud-rejection/register');

PrettyError.start();

const log = createLogger({name: 'benchmark'});

const resolveBinP = promisify(resolveBin);

const {argv} = yargs
  .usage('$0 <repo directory path>')
  .options({
    testRun: {
      type: 'boolean',
      describe: 'Instead of running the benchmark, run each benchmarked command against the input repo. ' +
      'This verifies that the codemods work. This is also useful to ensure that each benchmarked command is running ' +
      'against the same set of input files. If commands are running against different input sets, then the ' +
      'comparison will be invalid.'
    }
  })
  .check(argv => {
    if (argv._.length !== 1) {
      throw new Error('You must pass a repo to run on.');
    }
    return true;
  })
  .help();

async function runBenchmarks() {
  const repoToTransform = argv._[0];
  const execInRepo = (binPath, args, opts) => {
    log.debug({binPath, args, fullCommand: `${binPath} ${args.join(' ')}`});
    execa.sync(binPath, args, {...opts, cwd: repoToTransform});
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
  const jscodemodString = execOpts => execInRepo(
    binPath, 
    [
      '--codemod', pathFromRepoRoot('fixtures', 'prepend-string', 'codemod', 'codemod.js'), 
      '**/*.{js,ts,tsx}', '!node_modules'
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

  if (argv.testRun) {
    await resetChanges();
    jscodemodString({stdio: 'inherit'});
    await resetChanges();
    jscodeshiftString({stdio: 'inherit'});
    return;
  }

  const codemodBenchmark = benchmark.Suite({
    setup: resetChanges
  });

  codemodBenchmark
    .add('jscodemod#string', () => {
      jscodemodString({stdio: 'inherit'});
    })
    .add('jscodeshift#string', () => {
      jscodeshiftString({stdio: 'inherit'});
    })
    .on('complete', arg => {
      // This is brittle, but something more robust might be more complexity than it's worth, given Benchmark's API.
      const jscodemodStringStats = arg.currentTarget[0].stats;
      const jscodeshiftStringStats = arg.currentTarget[1].stats;
      
      const table = new CliTable({
        head: ['Runner', 'Transform', 'Mean Duration (seconds)', 'Standard Deviation (seconds)', 'Sample count']
      });

      // eslint-disable-next-line no-magic-numbers
      const significantDigits = number => number.toPrecision(3);

      const addTableEntry = (runnerName, transformName, stats) => 
        table.push([
          runnerName, transformName, significantDigits(stats.mean), significantDigits(stats.deviation), 
          stats.sample.length
        ]);

      addTableEntry('jscodemod', 'string', jscodemodStringStats);
      addTableEntry('jscodeshift', 'string', jscodeshiftStringStats);

      // This is intentional.
      // eslint-disable-next-line no-console
      console.log(table.toString());
    })
    .run();
}

runBenchmarks();
