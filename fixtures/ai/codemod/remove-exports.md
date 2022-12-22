In JS, a REX refactor is one where we remove the `export` keyword from variable declarations. Specifically, if a variable is not referenced in the `toExport` object construction, it shouldn't be exported.

For the following code:

```js
export const a = 123;
export const c = [];
export const d = () => {};
export const b = 'asdf';
const toExport = { a, b, c };
export default toExport;
```

A REX refactor results in:

```js
export const a = 123;
export const c = [];
const d = () => {};
export const b = 'asdf';
const toExport = { a, b, c };
export default toExport;
```    
Another example. For the following code:
```js
export const uio = 123;
export const opwe = [];
export const enrh = () => {};
export const aeem = 'asdf';
const toExport = { enrh, aeem };
export default toExport;
```

A REX refactor results in:
```js
const uio = 123;
const opwe = [];
export const enrh = () => {};
export const aeem = 'asdf';
const toExport = { enrh, aeem };
export default toExport;
```

Perform a REX refactor on the following code.  
```js
{{INPUT_SOURCE_CODE}}
```

Result of REX refactor (without any comments or extra prose):