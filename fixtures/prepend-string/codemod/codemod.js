module.exports = {
  transform({source}) {
    return `/* prefix prepend string */\n${source}`;
  }
};