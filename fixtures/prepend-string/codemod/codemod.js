const execa = require('execa');

module.exports = {
  ignore: /codemod-ignored/,
  postProcess: modifiedFiles => execa('echo', ['modified files post process', ...modifiedFiles]),
  transform({source}) {
    return `/* prefix prepend string */\n${source}`;
  }
};