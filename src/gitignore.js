// Adapted from https://github.com/sindresorhus/globby/blob/f67edfe92f6efd6f2c8dd974318a90b1c16dcb2c/gitignore.js

/* eslint-disable */

const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const fastGlob = require('fast-glob');
const gitIgnore = require('ignore');
const slash = require('slash');

const readFileP = promisify(fs.readFile);

const mapGitIgnorePatternTo = base => ignore => {
  if (ignore.startsWith('!')) {
    return '!' + path.posix.join(base, ignore.slice(1));
  }

  return path.posix.join(base, ignore);
};

const parseGitIgnore = (content, options) => {
  const base = slash(path.relative(options.cwd, path.dirname(options.fileName)));

  return content
    .split(/\r?\n/)
    .filter(Boolean)
    .filter(line => !line.startsWith('#'))
    .map(mapGitIgnorePatternTo(base));
};

const reduceIgnore = files => {
  const ignores = gitIgnore();
  for (const file of files) {
    ignores.add(
      parseGitIgnore(file.content, {
        cwd: file.cwd,
        fileName: file.filePath,
      })
    );
  }

  return ignores;
};

const ensureAbsolutePathForCwd = (cwd, p) => {
  cwd = slash(cwd);
  if (path.isAbsolute(p)) {
    if (slash(p).startsWith(cwd)) {
      return p;
    }

    throw new Error(`Path ${p} is not in cwd ${cwd}`);
  }

  return path.join(cwd, p);
};

const getIsIgnoredPredecate = (ignores, cwd) => {
  return p =>
    ignores.ignores(slash(path.relative(cwd, ensureAbsolutePathForCwd(cwd, p.path || p))));
};

const getFile = async (file, cwd) => {
  const filePath = path.resolve(cwd, file);
  try {
    const content = await readFileP(filePath, 'utf8');
    return {
      cwd,
      filePath,
      content,
    };
  } catch (e) {
    if (e.code === 'ENOENT') {
      Object.assign(e, { file });
    }

    throw e;
  }
};

const normalizeOptions = ({ ignore = [], cwd = slash(process.cwd()), paths } = {}) => {
  return { ignore, cwd, paths };
};

module.exports = async options => {
  options = normalizeOptions(options);

  const files = await Promise.all(options.paths.map(file => getFile(file, options.cwd)));
  const ignores = reduceIgnore(files);

  return getIsIgnoredPredecate(ignores, options.cwd);
};
