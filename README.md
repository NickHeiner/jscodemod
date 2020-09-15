# jscodemod
Codemod runner

## How to write a codemod
### Babel Plugin
1. Use [ASTExplorer](https://astexplorer.net/) with the "transform" option enabled for an interactive environment for developing your plugin.
1. Read the [Babel Plugin Handbook](https://github.com/jamiebuilds/babel-handbook/) to learn how to write a Babel plugin.

If your codebase has syntax that Babel doesn't recognize out of the box, you'll want need to handle it. (TypeScript, babel-plugin-proposal-pipeline-operator vs. babel-plugin-syntax-pipeline-operator).