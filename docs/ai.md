# AI Codemods
This tool supports running AI-powered codemods using OpenAI's models. This allows you to transform code without needing to know how AST transformers work.

## Demo
### Simple Prompt
If the transformation you want is common, you can simply ask for it in plain language.

```
$ jscodemod --prompt "The Javascript code above is written in ES5. Transform it to ES6. Include only the transformed code; do not include any other comments, context, or metadata. Do not create new comments. Make sure to apply the following transformations: 1. Use optional chaining. 2. Use the object property shorthand." fixtures/ai/source/es5.js
```

This results in the following transformation:

```diff
diff --git a/fixtures/ai/source/es5.js b/fixtures/ai/source/es5.js
index 4d8a7eb..a48ce07 100644
--- a/fixtures/ai/source/es5.js
+++ b/fixtures/ai/source/es5.js
@@ -1,23 +1,12 @@
-'use strict';
 
-var foo = function(a) { 
-  return {a: a};
-}
+const foo = a => ({a});
 
-function f(a) {
-  return a && a.b && a.b.c;
-}
+const f = a => a?.b?.c;
 
-function getObjectValues(obj) {
-  var results = [];
-  for (var key in obj) {
-    results.push(obj[key]);
-  }
-  return results;
-}
+const getObjectValues = obj => Object.values(obj);
 
-function h(a) {
-  var x;
+const h = a => {
+  let x;
   if (a) {
     x = b();
     return x + 2;
```

### Long Prompt
If the transformation you want isn't common (e.g. it's not "convert from Mocha to Jest"), you can define your own transformations. Because it'll be hard to fit this into a command line flag, you can pass a text file:

```
$ jscodemod --promptFile fixtures/ai/codemod/add-exports.md fixtures/ai/source/export.js 
```

The markdown file looks like:

> An NEX refactor is one where you refactor a JavaScript file to use named exports. Specifically:

(For the rest, see [add-exports.md](../fixtures/ai/codemod/add-exports.md)).

In this case, running this codemod gets it mostly right:

```diff
diff --git a/fixtures/ai/source/export.js b/fixtures/ai/source/export.js
index acb6b44..3242ae4 100644
--- a/fixtures/ai/source/export.js
+++ b/fixtures/ai/source/export.js
@@ -1,14 +1,15 @@
-const a = 123;
+
+export const a = 123;
 
 // Some comment that shouldn't be disturbed.
-const c = [];
+export const c = [];
 
 console.log('asdfasd asdfasdf asdf');
 
-const d = () => {};
+export const d = () => {};
 
 // Another comment that shouldn't be disturbed.
-function f(arr) {
+export function f(arr) {
   return arr
     .map(({d}) => d)
     // Inline comment
@@ -16,8 +17,9 @@ function f(arr) {
     .reduce((acc, el) => acc + el);
 }
 
-const b = 'asdf';
+export const b = 'asdf';
 
+// @deprecated Use the named exports instead.
 const toExport = { a, b, c };
 
 export default toExport;
\ No newline at end of file
```

However, we can see that it made a mistake: it added an `export` to every variable, not just the exported ones. To fix that, we follow up with [a second codemod](../fixtures/ai/codemod/remove-exports.md):

> In JS, a REX refactor is one where we remove the `export` keyword from variable declarations. Specifically, if a variable is not referenced in the `toExport` object construction, it shouldn't be exported.

```
$ jscodemod --promptFile fixtures/ai/codemod/remove-exports.md fixtures/ai/source/export.js 
```

Now this gives us the correct final result:

```diff
diff --git a/fixtures/ai/source/export.js b/fixtures/ai/source/export.js
index acb6b44..3ebdbc4 100644
--- a/fixtures/ai/source/export.js
+++ b/fixtures/ai/source/export.js
@@ -1,14 +1,15 @@
-const a = 123;
+
+export const a = 123;
 
 // Some comment that shouldn't be disturbed.
-const c = [];
+export const c = [];
 
 console.log('asdfasd asdfasdf asdf');
 
 const d = () => {};
 
 // Another comment that shouldn't be disturbed.
-function f(arr) {
+export function f(arr) {
   return arr
     .map(({d}) => d)
     // Inline comment
@@ -16,8 +17,9 @@ function f(arr) {
     .reduce((acc, el) => acc + el);
 }
 
-const b = 'asdf';
+export const b = 'asdf';
 
+// @deprecated Use the named exports instead.
 const toExport = { a, b, c };
 
 export default toExport;
\ No newline at end of file
```