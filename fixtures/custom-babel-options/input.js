// Passing retainFunctionParens to babelTransformOptions.generatorOpts should result in these parens being kept.
// If that option is not respected, these parens will be dropped.
const functionExpession = (function () {});

// If useRecast = true, then this string literal should be formatted with single quotes, since the codemod
// passes `quote: 'single'` to `generatorOpts`.
const string = "starts with double quotes";

module.exports = {
  functionExpession
};