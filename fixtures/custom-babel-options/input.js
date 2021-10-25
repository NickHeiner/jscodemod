// Passing retainFunctionParens to babelTransformOptions.generatorOpts should result in these parens being kept.
// If that option is not respected, these parens will be dropped.
const functionExpession = (function () {});

const string = 'starts with single quotes';

module.exports = {
  functionExpession
};