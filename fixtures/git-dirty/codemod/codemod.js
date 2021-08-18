module.exports = {
  ignore: 'dirty-transformed-by-second-codemod',
  transform({source}) {
    return `/* prefix git dirty */\n${source}`;
  },
  async postProcess(modifiedFiles, {jscodemod}) {
    console.log(JSON.stringify({modifiedFiles}));
    await jscodemod(
      require.resolve('./second-codemod'),
      {inputFilesPatterns: [require.resolve('../source/dirty-transformed-by-second-codemod')]}
    );
  }
};