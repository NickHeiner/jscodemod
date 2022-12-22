'use strict';

var foo = function(a) { 
  return {a: a};
}

function f(a) {
  return a && a.b && a.b.c;
}

function getObjectValues(obj) {
  var results = [];
  for (var key in obj) {
    results.push(obj[key]);
  }
  return results;
}

function h(a) {
  var x;
  if (a) {
    x = b();
    return x + 2;
  }
  return 4;
}