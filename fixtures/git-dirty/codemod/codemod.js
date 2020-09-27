module.exports = {
  transform({source}) {
    return `/* prefix git dirty */\n${source}`;
  }
};