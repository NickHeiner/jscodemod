module.exports = {
  transform({source}) {
    return `/* prefix */\n${source}`;
  }
};