### Usability
* Support for post-processing steps removes cases where you'd need to write a custom bash script.
* jscodeshift has a custom command line arg parser, which does not throw on unrecognized flags, making it easy to have a typo. JSCodemod uses [`yargs`](https://www.npmjs.com/package/yargs), which provides an interface familiar to users of many other Node tools, and does throw errors on unrecognized flags.
* jscodemod bypasses [the challenges of passing ignore patterns to jscodeshift](https://github.com/facebook/jscodeshift/issues/307), because it automatically will only process git-tracked files.

### Performance
I've observed jscodemod being 30x-50x faster than jscodeshift, on a comparison that simply does a string concatenation. (This removes any difference due to using different code parsers.)

The main reason for this performance difference is jscodemod uses Node's worker pool API (via [Piscina](https://www.npmjs.com/package/piscina)), rather than `child_process.fork`.

Use the included `./benchmark/index.js` script to run your own benchmarks. Here's a result of mine, running against [Nodejs](https://github.com/nodejs/node):

```
$ λ ./benchmark/index.js ~/code/node/
┌─────────────┬───────────┬─────────────────────────┬──────────────────────────────┬──────────────┐
│ Runner      │ Transform │ Mean Duration (seconds) │ Standard Deviation (seconds) │ Sample count │
├─────────────┼───────────┼─────────────────────────┼──────────────────────────────┼──────────────┤
│ jscodemod   │ string    │ 1.92                    │ 0.0542                       │ 6            │
├─────────────┼───────────┼─────────────────────────┼──────────────────────────────┼──────────────┤
│ jscodeshift │ string    │ 47.1                    │ 1.62                         │ 5            │
└─────────────┴───────────┴─────────────────────────┴──────────────────────────────┴──────────────┘
```