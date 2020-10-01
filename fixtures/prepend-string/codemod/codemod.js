module.exports = {
  ignore: /codemod-ignored/,
  postProcess: modifiedFiles => ({
    command: 'echo',
    args: ['modified files post process', ...modifiedFiles]
  }),
  transform({source}) {
    return `/* prefix prepend string */\n${source}`;
  }
};