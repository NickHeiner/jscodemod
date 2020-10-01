module.exports = {
  ignore: /codemod-ignored/,
  transform({source}) {
    return `/* prefix prepend string */\n${source}`;
  }
};