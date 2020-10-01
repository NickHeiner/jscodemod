module.exports = {
  ignore: /codemod-ignored/,
  postProcess: modifiedFiles => {
    console.log('codemod post process', JSON.stringify(modifiedFiles));
  },
  transform({source}) {
    return `/* prefix prepend string */\n${source}`;
  }
};