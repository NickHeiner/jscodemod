#! /usr/bin/env node

const yargs = require('yargs');
const path = require('path');
const benchmark = require('benchmark');
const resolveBin = require('resolve-bin');
const {promisify} = require('util');
const execa = require('execa');
const packageJson = require('../package');
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
      'This verifies that the codemods work.'
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
  const execInRepo = (binPath, args, opts) => execa.sync(binPath, args, {...opts, cwd: repoToTransform});

  const resetChanges = async silent => {
    if (!silent) {
      log.warn({repoToTransform}, `Resetting uncommited changes in ${repoToTransform}.`);
    }
    await execInRepo('git', ['restore', '.']);
  };

  const pathFromRepoRoot = (...pathParts) => path.resolve(__dirname, '..', ...pathParts);
  const binPath = pathFromRepoRoot(packageJson.bin);
  const jscodeshiftBinPath = await resolveBinP('jscodeshift', {executable: 'jscodeshift'});

  const jscodemodString = execOpts => execInRepo(
    binPath, 
    ['--codemod', pathFromRepoRoot('fixtures', 'prepend-string', 'codemod', 'codemod.js'), '.'],
    execOpts
  );
  const jscodeshiftString = execOpts => execInRepo(
    jscodeshiftBinPath, 
    ['--transform', pathFromRepoRoot('fixtures', 'prepend-string', 'codemod', 'jscodeshift-codemod.js'), '.'],
    execOpts
  );

  if (argv.testRun) {
    await resetChanges();
    jscodemodString({stdio: 'inherit'});
    await resetChanges();
    jscodeshiftString({stdio: 'inherit'});
  }

  // const codemodBenchmark = benchmark.Suite({
  //   setup() {
  //   } 
  // });

  // codemodBenchmark
  //   .add('jscodemod#string', () => {
  //     execaInTempDir(
  //       binPath, 
  //       ['--codemod', pathFromRepoRoot('test', 'fixtures', 'prepend-string', 'codemod', 'codemod.js')],
  //       '.'
  //     )
  //   })
  //   .on('complete', (arg) => {
  //     console.log('complete', {arg});
  //   })
  //   .run();
}

runBenchmarks();
