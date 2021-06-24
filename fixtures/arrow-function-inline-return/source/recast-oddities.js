#!/usr/bin/env node

const y = 1;

let x = 1; /* trailing comment */

/**
 * I was previously seeing issues where this would transform `return (\n expr \n)` to `return expr`, but I'm not seeing
 * that any more.
 */
function f() {
  return (
    true || false
  )
}

// Will be erroneously transformed because of https://github.com/benjamn/recast/issues/914.
const e = () => function(g, h) {
  return i;
};