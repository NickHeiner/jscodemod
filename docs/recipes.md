# Recipes & Common patterns

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
$ git rebase -r --onto <SHA>~1 <SHA>
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