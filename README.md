# jscodemod
JSCodemod is a codemod runner. Its codemods are written in JS/TS, but you can operate on any type of file.

## What's a codemod?
Codemods are automated code transformations – for instance, changing `a && a.b && a.b.c` to `a?.b?.c`. Codemods are useful for large codebases, where doing such a change by hand would put you at risk for making mistakes or developing repetitive stress injuries. (Additionally, automating the change allows you to more easily resolve merge conflicts with PR branches.)

## Don't we already have [jscodeshift](https://github.com/facebook/jscodeshift) for this?
Yes. I've used jscodeshift, which was created in 2015, in the past. However, I was inspired to make a new tool to address some gaps that I saw:

* jscodeshift performance and [usability](https://github.com/facebook/jscodeshift/issues/335) suffers on large codebases (jscodemod is 30x-50x faster than jscodeshift on codebases of 10,000+ files).
* jscodeshift has no support for [async](https://github.com/facebook/jscodeshift/issues/254) or TS transforms.
* When writing a complex transform with jscodeshift, you end up wrapping it in a bash script, which becomes painful.

For more detail, see [Comparison with JSCodeshift](docs/comparison-with-jscodeshift.md).

## CLI Usage
To specify which files to run on, pass a set of [globby](https://www.npmjs.com/package/globby) patterns. Depending on your shell, you may need to wrap the patterns in single quotes to prevent shell expansion:

```
# Will be shell expanded, which may not be what you want
$ jscodemod --codemod codemod.js src/**/*.js

# Will not be shell expanded
$ jscodemod --codemod codemod.js 'src/**/*.js'
```

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

