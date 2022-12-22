# jscodemod
JSCodemod is a codemod runner. Its codemods are written in JS/TS, or [generated via AI](./docs/ai.md). You can operate on any type of file.

## Example

```
$ jscodemod --codemod codemod.js src/**/*.js
```

Run with `--help` to see other options.

## What's a codemod?
Codemods are automated code transformations – for instance, changing `a && a.b && a.b.c` to `a?.b?.c`. Codemods are useful for large codebases, where doing such a change by hand would put you at risk for making mistakes or developing repetitive stress injuries. (Additionally, automating the change allows you to more easily resolve merge conflicts with PR branches.)

## Don't we already have [jscodeshift](https://github.com/facebook/jscodeshift) for this?
Yes. I've used jscodeshift, which was created in 2015, in the past. However, I was inspired to make a new tool to address some gaps that I saw:

* jscodeshift performance and [usability](https://github.com/facebook/jscodeshift/issues/335) suffers on large codebases (jscodemod is 30x-50x faster than jscodeshift on codebases of 10,000+ files).
* jscodeshift has no support for [async](https://github.com/facebook/jscodeshift/issues/254) or TS transforms.
* When writing a complex transform with jscodeshift, you end up wrapping it in a bash script, which becomes painful.
* This tool allows you to use a babel plugin directly.

For more detail, see [Comparison with JSCodeshift](docs/comparison-with-jscodeshift.md). To see more things that you can do easily with jscodemod that you can't do easily with jscodeshift, see [Recipes](docs/recipes.md).

## CLI Usage
To specify which files to run on, pass a set of [globby](https://www.npmjs.com/package/globby) patterns. Depending on your shell, you may need to wrap the patterns in single quotes to prevent shell expansion:

```
# Will be shell expanded, which may not be what you want
$ jscodemod --codemod codemod.js src/**/*.js

# Will not be shell expanded
$ jscodemod --codemod codemod.js 'src/**/*.js'
```

## How to write a codemod
The argument you pass to `--codemod` is a file that exports a `Codemod`. Look in [Types](src/types.ts) for the semantics of that object.
### Babel Plugin
1. Use [ASTExplorer](https://astexplorer.net/) with the "transform" option enabled for an interactive environment for developing your plugin.
1. Read the [Babel Plugin Handbook](https://github.com/jamiebuilds/babel-handbook/) to learn how to write a Babel plugin.

### Examples
Using the low-level `transform` API:
```ts
import type {Codemod} from '@nick.heiner/jscodemod';

const codemod: Codemod = {
  // Ignore files with paths matching these regexes, or including these strings.
  ignore: [new RegExp('path/to/a.js'), 'path/to/b.js', /directory-to-omit/],

  // Ignore files specified by these config files used by other tools
  ignoreFiles: ['path/to/.eslintignore', 'path/to/.npmignore'],

  transform({source}) { /* ... */ }

  // Take actions after the codemod has run.
  async postProcess(modifiedFiles, {jscodemod}) {
    // Run a second codemod on the set of files we modified in the first phase.
    await jscodemod(
      require.resolve('path/to/second-codemod-phase'),
      modifiedFiles
    )
  }
}
```

Using the high-level `getPlugin` API:
```ts
import type {Codemod} from '@nick.heiner/jscodemod';
const codemod: Codemod = {
  // Whatever presets are needed to parse your code.
  presets: ['@babel/preset-react', '@babel/preset-typescript', '@babel/preset-env']

  // The transformation you'd like to do in the codemod.
  getPlugin({source, fileName}) {
    return ({types: t}) => ({
      visitor: {
        /* ... your babel plugin here */
      }
    })
  }
}
```

## More Docs
* [Recipes](docs/recipes.md)
* [Gotchas](docs/gotchas.md)
* [API documentation](src/types.ts)

## Changelog
### 3.0.0
* **TypeScript**: Codemods implemented in TS now will use a different exported type.

```ts
// Previous
import type { Codemod } from '@nick.heiner/jscodemod';

// New: Use the specific type that applies to your codemod.
// See ./src/types.ts for definitions.
import type { BabelCodemod, LowLevelCodemod, AICodemod } from '@nick.heiner/jscodemod';
```

### 2.0.0
Drop support for NodeJs 12.