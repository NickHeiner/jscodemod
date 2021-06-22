module.exports = {
  name: 'my-codemod-name',
  transform({filePath}) {
    throw new Error(`Error for: ${filePath}`);
  }
};