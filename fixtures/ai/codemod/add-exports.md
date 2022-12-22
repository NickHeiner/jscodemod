An NEX refactor is one where you refactor a JavaScript file to use named exports. Specifically:

1. If a variable is present in the `toExport` object, export that variable directly. 
2. Add a JSDoc comment to the `toExport` object, marking it as deprecated.

For example, given this input:

```jsx
function a() { return 1 }
function b() { return 0 }
const c = 'asdf';
const d = 1234;

const toExport = { a, b, c };

export default toExport;
```

An NEX refactor would result in:

```jsx
export function a() { return 1 }
export function b() { return 0 }
export const c = 'asdf';
const d = 1234;

// @deprecated Use the named exports instead.
const toExport = { a, b, c };

export default toExport;
```

Perform a NEX refactor on the following code.  
```js
{{INPUT_SOURCE_CODE}}
```

Result of NEX refactor (without any comments or extra prose):
