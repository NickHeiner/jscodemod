### Workflow & Codemod Authoring
* Support for post-processing steps removes cases where you'd need to write a custom bash script. For example:
  ```js
  const codemod = {
    transform({source}) { /* ... */ }

    async postProcess(modifiedFiles, {jscodemod}) {
      // Run a second codemod on the set of files we modified in the first phase.
      await jscodemod(
        require.resolve('path/to/second-codemod-phase'),
        modifiedFiles
      )
    }
  }
  ```
* At scale, codemod authors often need to exclude some files from processing. In jscodeshift, you'd do something like:
  ```js
  const IGNORED_FILES = ['path/to/a.js', 'path/to/b.js']
    // We need to convert to absolute paths, 
    // because that's what jscodeshift gives the transform.
    .map(file => path.resolve(repoRoot, file)); 

  function transform({source, filePath}) {
    if (IGNORED_FILES.some((f) => file.path.includes(f)) || filePath.includes('directory-to-omit')) {
      return;
    }
  }
  ```
  With jscodemod, use the built-in ignore functionality:
  ```ts
  const codemod = {
    ignore: [new RegExp('path/to/a.js'), 'path/to/b.js', /directory-to-omit/]
    ignoreFiles: ['path/to/.eslintignore', 'path/to/.npmignore']
    // ...
  }
  ```
* By default, jscodeshift attempts to parse your code. In my opinion, this is brittle. jscodemod makes no attempt to parse your code – you handle it by default. 

### Usability
* jscodeshift has a custom command line arg parser, which does not throw on unrecognized flags, making it easy to have a typo. JSCodemod uses [`yargs`](https://www.npmjs.com/package/yargs), which provides an interface familiar to users of many other Node tools, and does throw errors on unrecognized flags.
* jscodemod bypasses [the challenges of passing ignore patterns to jscodeshift](https://github.com/facebook/jscodeshift/issues/307), because it automatically will only process git-tracked files.
* [jscodeshift's documentation is lacking.](https://github.com/facebook/jscodeshift/issues/390) I suppose that if one feels this way, one could just avoid using the undocumented parts of jscodeshift. But I feel like it's not doing users any favors to suggest that using these APIs is the primary way to use the tool, but then not document those APIs. By contrast, jscodemod fully documents everything that is available to users. 

### Performance
I've observed jscodemod being 30x-50x faster than jscodeshift, on a comparison that simply does a string concatenation. (This removes any difference due to using different code parsers.)

The main reason for this performance difference is jscodemod uses Node's worker pool API (via [Piscina](https://www.npmjs.com/package/piscina)), rather than `child_process.fork`.

Use the included `./benchmark/index.js` script to run your own benchmarks. Here's a result of mine, running against [Nodejs](https://github.com/nodejs/node):

```
$ ./benchmark/index.js ~/code/node/
┌─────────────┬───────────┬─────────────────────────┬──────────────────────────────┬──────────────┐
│ Runner      │ Transform │ Mean Duration (seconds) │ Standard Deviation (seconds) │ Sample count │
├─────────────┼───────────┼─────────────────────────┼──────────────────────────────┼──────────────┤
│ jscodemod   │ string    │ 1.92                    │ 0.0542                       │ 6            │
├─────────────┼───────────┼─────────────────────────┼──────────────────────────────┼──────────────┤
│ jscodeshift │ string    │ 47.1                    │ 1.62                         │ 5            │
└─────────────┴───────────┴─────────────────────────┴──────────────────────────────┴──────────────┘
```