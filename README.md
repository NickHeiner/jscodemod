# jscodemod
Codemod runner

## CLI Usage
To specify which files to run on, pass a set of [globby](https://www.npmjs.com/package/globby) patterns. Depending on your shell, you may need to wrap the patterns in single quotes to prevent shell expansion:

```
# Will be shell expanded, which may not be what you want
$ jscodemod --codemod codemod.js src/**/*.js

# Will not be shell expanded
$ jscodemod --codemod codemod.js 'src/**/*.js'
```

## Comparison with jscodeshift
Piscina v. `child_process.fork`.
Yargs v. custom arg parser. Yargs throws errors on unrecognized flags (e.g. `--typo-flag --codmod`), whereas the JSCodeshift custom parser does not.

### Performance
I've observed jscodemod being 30x-50x faster than jscodeshift, on a comparison that simply does a string concatenation. (This removes any difference due to using different code parsers.)

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

### Issues
https://github.com/facebook/jscodeshift/issues/307

## How to write a codemod
### Babel Plugin
1. Use [ASTExplorer](https://astexplorer.net/) with the "transform" option enabled for an interactive environment for developing your plugin.
1. Read the [Babel Plugin Handbook](https://github.com/jamiebuilds/babel-handbook/) to learn how to write a Babel plugin.

If your codebase has syntax that Babel doesn't recognize out of the box, you'll want need to handle it. (TypeScript, babel-plugin-proposal-pipeline-operator vs. babel-plugin-syntax-pipeline-operator).

### Gotchas
TypeScript lets you write the following:

```ts
import babel from '@babel/core';
babel.transformSync();
```

However, this does not actually work. Instead, write:

```ts
import {transformSync} from '@babel/core';
transformSync();
```

**Why does this happen?**

It might be because this tool does the TS compilation of codemods incorrectly. But here's what I've discovered:

`@babel/core` defines itself as ESM in its compiled output:

```js
Object.defineProperty(exports, "__esModule", {
  value: true
});
```

When that property is set, the JS compiled from the codemod's TS expects `exports.default` to be set, but Babel does not set it:

```js
// Your compiled codemod
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const core_1 = __importDefault(require("@babel/core"));

// This fails because there is no "default".
core_1.default.transformSync()
```

If this is supposed to work and I messed it up, please let me know. :)

TODO: maybe this has to do with `esModuleInterop`.

# Misc
Piscina caveat https://github.com/piscinajs/piscina#multiple-thread-pools-and-embedding-piscina-as-a-dependency