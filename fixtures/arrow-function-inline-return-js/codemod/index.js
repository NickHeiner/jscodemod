const babelPlugin = require('./babel-plugin');
const babel = require('@babel/core');
const {parse, print} = require('recast');

module.exports = {
  transform({source, filePath}) {
    const ast = parse(source, {parser: babel});
    const result = babel.transformFromAstSync(ast, source, {
      filename: filePath,
      plugins: ['@babel/plugin-syntax-optional-chaining', '@babel/plugin-syntax-typescript', babelPlugin],
      ast: true
    });
    if (!result) {
      throw new Error(`Transforming "${filePath}" resulted in a null babel result.`);
    }

    return print(result.ast).code;
  }
};