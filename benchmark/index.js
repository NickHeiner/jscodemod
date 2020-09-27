#! /usr/bin/env node

const yargs = require('yargs');
const path = require('path');
const benchmark = require('benchmark');
const tempy = require('tempy');
const execa = require('execa');
const packageJson = require('../package');
const createLogger = require('nth-log').default;
const PrettyError = require('pretty-error');
require('loud-rejection/register');

PrettyError.start();

const log = createLogger({name: 'benchmark'});

const {argv} = yargs
  .usage('$0 <repo clone URL>')
  .option({
    repoDir: {
      type: 'string',
      describe: 'If passed, use this'
    }
  })
  .check(argv => {
    if (!argv.repoDir && argv._.length !== 1) {
      throw new Error('You must pass one repo to clone.');
    }
    return true;
  })
  .help();

async function runBenchmarks() {
  const tempDir = await tempy.directory({prefix: `${packageJson.name}-benchmark`});
  const execaInTempDir = (binPath, args, opts) => execa.sync(binPath, args, {...opts, cwd: tempDir});

  const repoToTransform = argv._[0];
  execaInTempDir('git', ['clone', repoToTransform, tempDir], {stdio: 'inherit'});

  const codemodBenchmark = benchmark.Suite({
    setup() {
      execaInTempDir('git', ['restore', '.'], {cwd: tempDir});
    } 
  });

  const pathFromRepoRoot = (...pathParts) => path.resolve(__dirname, '..', ...pathParts);
  const binPath = pathFromRepoRoot(packageJson.bin);

  execaInTempDir(
    binPath, 
    ['--codemod', pathFromRepoRoot('test', 'fixtures', 'prepend-string', 'codemod', 'codemod.js')],
    '.'
  )

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
