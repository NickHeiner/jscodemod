const babelPlugin = require('./babel-plugin');
const babel = require('@babel/core');
const {parse, print} = require('recast');
const _ = require('lodash');

module.exports = {
  transform({source, filePath}) {
    return babel.transformSync(source, {
      filename: filePath,
      plugins: ['@babel/plugin-syntax-optional-chaining', '@babel/plugin-syntax-typescript', babelPlugin],
      ast: true
    }).code;
    // const babelOpts = {
    //   filename: filePath,
    //   plugins: ['@babel/plugin-syntax-optional-chaining', '@babel/plugin-syntax-typescript', babelPlugin],
    //   ast: true
    // };
    
    // const parser = {
    //   parse(source, opts) {
    //     return babel.parse(source, {
    //       ...babelOpts,
    //       ..._.omit(
    //         opts, 
    //         'jsx', 'loc', 'locations', 'range', 'comment', 'onComment', 'tolerant', 'ecmaVersion'
    //       )
    //     });
    //   }
    // };
    
    // const ast = parse(source, {parser});
    // const result = babel.transformFromAstSync(ast, source, babelOpts);
    // if (!result) {
    //   throw new Error(`Transforming "${filePath}" resulted in a null babel result.`);
    // }

    // return print(result.ast).code;
  }
};