module.exports = {
  transform({source}) {
    return `/* prefix git dirty second codemod */\n${source}`;
  }
};