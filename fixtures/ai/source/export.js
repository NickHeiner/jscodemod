const a = 123;

/**
 * Some comment that shouldn't be disturbed.
 */

const c = [];

console.log('asdfasd asdfasdf asdf');

const d = () => {};

/**
 * Another comment that shouldn't be disturbed.
 */

function f(arr) {
  return arr
    .map(({d}) => d)
    // Inline comment
    .filter(({g}) => e(g))
    .reduce((acc, el) => acc + el);
}

const b = 'asdf';

const toExport = { a, b, c };

export default toExport;