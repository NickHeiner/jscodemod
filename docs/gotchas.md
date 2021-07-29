# Gotchas

## Transforming files simultaneously
If you have a codemod that reads other files, and those files are also being transformed in the same codemod pass, you may experience race conditions. For example:

```js
const codemod = {
  async transform({source}) {
    const otherFileContents = await readFile(otherFilePath);
    return check(otherFileContents) ? modify(source) : source;
  }
}
```

If `otherFilePath` also refers to a file being transformed, you won't know if you'll read the file before or after the transform occurs. Or, if your codemod isn't atomic, and leaves the file in a dirty state for some period of time, you could read it in that dirty state.

There is no current workaround for this, but this issue is more likely to occur when using the in-process transform, rather than the Piscina worker pool. To force use of Piscina, pass flag `--piscinaLowerBoundInclusive=1`. It'll make your codemod slower, but may change the timing such that your race conditions don't appear.

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
