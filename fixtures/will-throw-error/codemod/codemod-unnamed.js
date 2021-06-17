module.exports = {
  transform({filePath}) {
    throw new Error(`Error for: ${filePath}`);
  }
};