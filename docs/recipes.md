# Recipes & Common patterns

## (Experimental) TypeScript Codemod
Using TS for your codemod will provide the most support, but it may have some bugs. You can always fall back to JS if 
you run into issues.

```ts
import type { Codemod } from '@nick.heiner/jscodemod';
import type { NodePath } from '@babel/traverse';
import type { JSXOpeningElement } from '@babel/types';

const codemod: Codemod = {
    getPlugin() {
        return () => ({
            visitor: {
                JSXOpeningElement(jsxPath: NodePath<JSXOpeningElement>) {
                    /* ... */
                }
            }
        })
    }
}

export default codemod;
```

## Commit all changed files
```js
const execa = require('execa');
const execBigCommand = require('@nick.heiner/jscodemod/build/exec-big-command').default;

const cjsToEsmCodemod = {
    /* ... */

    async postProcess(changedFiles, { jscodemod }) {
        if (!changedFiles.length) {
            return;
        }
        await execBigCommand(['add'], changedFiles, (args) => execa('git', args, { stdio: 'inherit' }));
        await execa('git', ['commit', '--no-verify', '-m', '[Automated] Run codemod to fix the glip glops.'], {
            stdio: 'inherit',
        });
    },
};

module.exports = cjsToEsmCodemod;
```

In conjunction with the flag `jscodemod --resetDirtyInputFiles`, this creates a commit that's only the automated changes from the codemod. 

After inspecting the changes, if you want to discard the commit, use this one-liner to rebase it out of your history:

```
$ git rebase -r --onto <COMMIT_SHA>~1 <COMMIT_SHA>
```

## Run multiple codemods sequentially
If you want to implement your codemod in multiple phases, use the `postProcess` hook:

```js
const codemod = {
    async postProcess(changedFiles, { jscodemod, }) {
        await jscodemod(require.resolve('./second-phase'), changedFiles);
        await jscodemod(require.resolve('./third-phase'), 'custom/pattern/**/*.js');
    }
}
```

**Note:** Unfortunately, passing flag `--resetDirtyInputFiles` won't work with a multi-step codemod like this. `jscodemod` will reset the dirty input files before each phase, so if you touch the same files in multiple phases, the later phases will clobber the results of the earlier phases.

## Query your code
Sometimes, you might not want to make any changes, but do want to use Babel's power to query your code. For example, let's say we want to find all instances of a function named `g`, and see how many arguments it was called with:

```js
module.exports = {
    presets: [],
    getPlugin({ willNotifyOnAstChange, setMetaResult }) {
        // Because we don't plan to modify the AST, call this function, then never call astDidChange(). That way, jscodemod
        // won't change the file.
        willNotifyOnAstChange();

        let mostArgumentsSeen = -Infinity;

        return () => ({
            visitor: {
                CallExpression(path) {
                    // CallExpression with callee.type = 'Identifier' and callee.name = 'g' matches:
                    //   g(a, b, c);
                    if (path.node.callee.type === 'Identifier' && path.node.callee.name === 'g') {
                        // Record how many arguments there are.
                        mostArgumentsSeen = Math.max(mostArgumentsSeen, path.node.arguments.length);
                    }
                },
                Program: {
                    exit() {
                        setMetaResult(mostArgumentsSeen);
                    },
                },
            },
        });
    },
    postProcess(_, { resultMeta }) {
        // resultMeta will be a Map where the key is the absolute file path, and the value is whatever we called
        // setMetaResult with. For example:
        //
        //  { '/path/to/a.js': 1, '/path/to/b.js': 23 }
        console.log(resultMeta);
    },
};
```

Run this inert codemod over your the code you want to query, and you'll get your result `console.log`ed at the end:

```
$ jscodemod --codemod my-codemod.js 'source/**/*.{js,ts}'
```

## Run a JSCodeshift Codemod
If you have a JSCodeshift codemod, but you'd like to take advantage of [jscodemod's comparative strengths](./comparison-with-jscodeshift.md), you can do that with a `transform` codemod:

```js
// File: codemod.js

const j = require('jscodeshift');

// Run with `jscodemod --codemod path/to/codemod.js 'my/{input,files}/**/*.js'`
module.exports = {
    transform({source, filePath}) {
        const root = j(source);
        root.find(j.Identifier, {name: 'myVar'}).forEach(/* ... */)
        return root.toSource();
    }
}
```

## Unit test your codemod
For more complicated codemods, it's useful to create a test suite. To help you do this, you can use the exported function `getTransformedContentsOfSingleFile`. For example, with Jest:

```js
import { getTransformedContentsOfSingleFile } from '@nick.heiner/jscodemod';

it('transforms my input file correctly', async () => {
    expect(
        await getTransformedContentsOfSingleFile(
            // Path to your codemod
            require.resolve('../codemod'),

            // Path to your fixture file
            require.resolve('../__fixtures__/my-input-file'),
        ),
    ).toMatchSnapshot();
});
```

The recommended pattern is to add fixtures for each different type of case your codemod may encounter. 

## Limit your codemod to only running on certain files
The `ignore` codemod entry allows you to omit files from processing. If you'd rather write an include-list than deny-list, you can use a [regex negative lookahead](https://stackoverflow.com/a/1749956/147601). For example:

```js
// Only process files ending in .js, .ts, or .tsx
ignore: /\.(?!(js|tsx|ts))[^.]+$/
```

## How do I choose between the `getPlugin()`, `transform()`, and `transformAll()` APIs?
When defining your codemod, you can specify one of three functions for transforming files. Choose the one that best fits your needs:

### `getPlugin()`
* Pro: ideal for transformations that can be expressed as Babel plugins. Babel provides a robust, somewhat-well-documented AST transformation API, so it tends to be my first choice.
* Con: If your project isn't compatible with the version of Babel that jscodemod bundles, you might run into issues. And there are other funky things that can happen (as documented in [the types](../src/types.ts)) when using Babel + Recast.

### `transform()`
* Pro: Dead simple, low-level API with no coupling to other toolchain pieces like Babel.
* Con: You have to handle all transformation logic yourself.

### `transformAll()`
Used for when you need fine-grained control over how files are written, when you're integrating with a third-party tool, or otherwise need a lower-level API. For instance:

```js
import { rename } from 'ts-migrate';

transformAll({fileNames}) {
    rename({
        ..._.pick(commandLineArgs, 'rootDir'),
        sources: fileNames
    });
    /* ... */
}
```

In this example, we're able to use `rename`, but still get jscodemod's other functionality (e.g. file ignoring, globbing, post processing).

Additionally, using `transformAll` is the only way to rename files with jscodemod. `transform` and `getPlugin` will modify a file, but they don't change the file name.