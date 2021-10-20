# Gotchas

## Performance
Some codemods will cause 30-40 second delays as the Piscina pool starts up. I've investigated but I'm not able to definitively say what the trigger is; it seems related to your codemod `require`ing a lot of JS code, and/or spawning subshells.

To get around this, pass flag `--piscinaLowerBoundInclusive=<some number higher than the number of files you have>`. It'll put you at risk for the "transforming files simultaneously" issue above, but it'll improve the perf.

Or, if possible, refactor your codemod to `require` or spawn subshells less.

## `getPlugin()` Recast Issues
When you use the `getPlugin()` API, jscodemod uses `recast` to ensure that your code formatting is retained. However, sometimes `recast` makes mistakes, which can change your program semantics. Here are issues I've run into:

* https://github.com/benjamn/recast/issues/914
* https://github.com/benjamn/recast/issues/985

Fortunately, these cases have not been common in my experience.

Workarounds:
* If this only impacts a small set of files for you, configure your codemod to ignore them (via the `ignore` field), and migrate those by hand.
* Or, use the `transform()` API, and transform your code using jscodeshift's transformer APIs, instead of Babel.
* Or, return `useRecast: false` to disable `recast` for files that it trips up on. A few ways to do this:

```js
// Always disable Recast.
getPlugin() {
  return {
    plugin: myBabelPlugin,
    useRecast: false
  }
}
```

```js
// Disable Recast for certain files.
getPlugin({filePath}) {
  const filesToDisableRecastFor = ['a.js', /* ... etc */];
  return {
    plugin: myBabelPlugin,
    useRecast: !filesToDisableRecastFor.includes(filePath)
  }
}
```

```js
// Scan files for a condition that makes Recast fail for them, then split out into two codemod phases.
getPlugin: ({filePath, setMetaResult}) => () => ({
  Program(astPath) {
    // Traverse the AST and figure out if this file triggers a Recast issue.
    setMetaResult(recastWillMessThisFileUp(astPath));
  }
}),
postProcess(_, {resultsMeta, jscodemod}) {
  const recastSkipFiles = [];
  
  for (const [filePath, recastWillMessItUp] of resultsMeta.entries()) {
    if (recastWillMessItUp) {
      recastSkipFiles.push(filePath);
    }
  }

  // Run our actual transformation in the second phase, now that we know which files are safe to recast. 
  await jscodemod(
    require.resolve('./codemod-phase-two'), {
      // resultsMeta.keys() is the entire set of files we ran against in this phase, since we called setMetaResult for
      // each file.
      inputfilesPatterns: resultsMeta.keys(),

      // Pass an argument to the next codemod telling it which files to skip recast for.
      codemodArgs: recastSkipFiles
    }
  )
}
```

## Babel Parse v. Transform
If: 
1. You're using the low-level `transform` API
1. You're codemodding your code with Babel
1. You have syntax that Babel can't handle by default (e.g. React, TypeScript, the latest ES proposals)

Then you'll need to tell Babel how to parse your code. However, you don't want to actually apply these transformations,
because unlike the compilation step, you're outputting source code, not built code. (For example, if you have optional
chaining syntax in your source, you don't want your codemod to compile that to ES5.)

The solution to this is to do two phases:

```js
const ast = babelParse(source, {ast: true, presets});
const transformedAst = babelTransform(ast, plugins: [myCodemodPlugin]);
const source = babelGenerate(transformedAst);
```

Of course, `babelGenerate` will lose your formatting, so you'll probably want to use `recast`.

If you use the `getPlugin` API, this is all handled for you.

## Side Effects
Your codemod will be loaded many times by the worker pool threads, so be careful about side effects. For example:

```js
// This line will be executed many times, depending on how the worker pool is managed.
fs.writeFile(path, contents);

const codemod = /* ... */

export default codemod;
```

Additionally, unlike with a codemod framework that does everything in one process, you can't share context between worker pool threads:

```js
// This will not be shared globally. Because each worker pool thread loads the codemod separately, this closure variable
// will only be visible to the thread that loaded it.
let totalFilesTransformed = 0;

const codemod = {
  transform({source}) {
    const newSource = transform(source);
    if (newSource !== source) {
      totalFilesTransformed++;
    }
    return newSource;
  }
}

export default codemod;
```

If these limitations are a problem, you can disable Piscina, and do everything in-process, by passing this flag: `--piscinaLowerBoundInclusive=9999999`. (Just pass a number that's higher than the set of files you're transforming, but less than `Number.MAX_SAFE_INTEGER`.)

## Importing Babel
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

<!-- TODO: maybe this has to do with `esModuleInterop`. -->

