const variable = 'value';

// Passing retainFunctionParens to babelTransformOptions.generatorOpts should result in these parens being kept.
// If that option is not respected, these parens will be dropped.
const g = (function() {});

module.exports = {
  renamed: variable,
};