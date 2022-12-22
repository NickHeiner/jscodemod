# AI Codemods
This tool supports running AI-powered codemods using OpenAI's models. This allows you to transform code without needing to know how AST transformers work.

## Demo
### Simple Prompt: Converting old JS to modern JS
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

### Simple Prompt: Converting a React class component to a functional one
```
$ jscodemod --prompt "Above, we have a React class component. Convert it to be a functional component, which uses hooks instead of this.setState and the lifecycle methods. Only return a single example. Do not include any other comments or prose." fixtures/ai/source/react-component.js
```

This results in:

**Before**
```js
class NameList extends React.Component {
  constructor(props) {
    super(props);
    this.state = {names: []};
  }

  componentDidMount() {
    console.log('mount side effect');
    this.timerID = setInterval(
      () => this.addName(),
      1000
    );
  }

  componentWillUnmount() {
    console.log('unmount side effect'); 
    clearInterval(this.timerID);
  }

  addName() {
      this.setState(({names}) => names.push(`name ${names.length}`))
  }

  render() {
    return (
      <div>
        <h1>Hello, world!</h1>
        <h2>Names: {this.state.names.join(',')}</h2>
      </div>
    );
  }
}
```

**After**
```js

function NameList() {
  const [names, setNames] = useState([]);

  useEffect(() => {
    console.log('mount side effect');
    const timerID = setInterval(
      () => setNames(names => [...names, `name ${names.length}`]),
      1000
    );
    return () => {
      console.log('unmount side effect');
      clearInterval(timerID);
    }
  }, []);

  return (
    <div>
      <h1>Hello, world!</h1>
      <h2>Names: {names.join(',')}</h2>
    </div>
  );
}
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

### More Complicated Codemods: Configuring AI Params
The above examples use default params for the AI generation. However, you can pass your own:

```
$ jscodemod --aiConfig '{"best_of": 5}'

$ jscodemod --aiConfigFile path/to/config.json
```

In this example, we set the [`best_of`](https://beta.openai.com/docs/api-reference/completions/create#completions/create-best_of) property to tell the server to generate multiple completions and pick the best one.

### Advanced: Full Programmatic Control
The above examples keep everything on the command line, and as such make some simplifying assumptions. If you want full control, you can define your own codemod:

```ts
import {AICodemod} from '@nick.heiner/jscodemod';

const codemod = {
  getCompletionRequestParams({source}) {
    return {
      model: 'code-davinci-002',
      prompt: `
        ${source}

        // The Javascript code above is written in ES5. Here's what it looks like translated to modern JS:
      `
    }
  },
  extractTransformationFromCompletion(response) {
    return response.choices[0].text;
  }
} satisfies AICodemod;

export default codemod;
```

This allows you to have full control over the params passed to OpenAI, as well as apply any transformations you want to the response.

Note that if you do this, you need to specify all `createCompletionRequestParams`. For instance, the default value for `max_tokens` is `16`, which is very low. You'll likely want to set that to the model max (`2048` at this moment), so the model can return a long enough response to transform your entire file.

See [the types](../src/types.ts) for a full definition of the API.

### Run these demos yourself
1. Clone this repo.
1. `yarn`
1. Run the `yarn demo:*` commands listed in [`package.json`](../package.json).

## Best Practices & Guide
### Mindset
Codemodding with AI is a different workflow than writing a normal codemod. 

Your normal workflow loop looks something like:
1. Pick a code case to handle in your codemod.
1. Implement the codemod to handle it.
1. Write unit tests for your codemod.
1. Apply your codemod to those cases.
1. Open a PR. Lightly spot-check the results.
1. Repeat.

With an AI codemod, you skip the "implement" and "write tests" step. However, you'll likely need to apply a little more editing to the result of what the codemod gives you. It probably won't be safe to run the codemod on 5000 files and merge without further verification. But moving from "I need to migrate all this myself" to "someone else gets it 95% of the way and I just have to edit their output" is a big help.

Additionally, **AI model responses are not deterministic.** Every time you run, you could get something different. If you like a result, save it. So rather than say, "I like this prompt's results for 5 files, but I'm going to keep tweaking my prompt until I like it for all 10", just save your 5 good files and move on.

### Prompt Engineering
As with all generative AI, finding a good prompt (and other parameters) is the key to getting the result you're looking for. It seems like something you just need to [experiment with](https://beta.openai.com/playground/p/gXdPByzqByPdjMoJXmNvBnmj?model=code-davinci-002). For your workflow, I recommend experimenting in the playground. Then, use this tool when you're ready to apply the results to your codebase. 

Here are some heuristics I've found:

#### Be Specific
It's better to call out the specific changes you want.

Bad:
> The Javascript code above is written in ES5. Transform it to ES6.

Good:
> The Javascript code above is written in ES5. Transform it to ES6. Include only the transformed code; do not include any other comments, context, or metadata. Do not create new comments. Make sure to apply the following transformations: 1. Use optional chaining. 2. Use the object property shorthand.

#### Give Multiple Examples
If you're defining your own codemod with examples, make sure to give a few examples that exercise different conditions. For instance:

> A FOO refactor is one where we reverse the names of all functions that return numbers. For instance, given this code:
>   function forward() { return 2; }    
>   function original() { return 'asf'; }    
>
> A FOO refactor would result in:
>   function drawrof() { return 2; }    
>   function original() { return 'asf'; }    

If this is the only example you give, the AI might learn the lesson "rename the first function". If you're getting bad results, you may wish to provide additional sample transformations.

(Note: I actually couldn't get even a longer form of this prompt to work as a codemod, but was able to get the AI to [generate a codemod](https://beta.openai.com/playground/p/fHLPwP4nrF5emnrtJv921rOZ?model=code-davinci-002) that would handle some cases.)

#### Sometimes you just need to tweak random things
Between the following two forms:

```js
const my_code_to_transform = 1245;

// <description of the transform I want>
```

```js
const my_code_to_transform = 1245;

/* <description of the transform I want> */
```

The latter works better.

I think there are a few seemingly-random things like this, and discovering them is just a matter of trial and error.

### API Params
#### Set [`temperature`](https://beta.openai.com/docs/api-reference/completions/create#completions/create-temperature) low
The higher the `temperature`, the more "creative" the AI gets. When transforming code, we generally don't want creativity. 

#### Set [`max_tokens`](https://beta.openai.com/docs/api-reference/completions/create#completions/create-max_tokens) to match the input length
`max_tokens` determines how long of a response the AI will generate. (Tokens are not the same as characters; see the [tokenizer](https://beta.openai.com/tokenizer).)

In my experimenting, I saw that the AI would sometimes include extraneous content. For instance, I'd ask it to transform a React class component to a functional one, and it would give me three ways to do it, plus some comments explaining what's going on.

One way to address this is to explicitly say things like "don't add new comments" in the prompt.

But you can also set the `max_tokens` to be something close to length of your input file, which gives the AI less room to add extraneous content.


### Combining Both Approaches
You can also ask the AI to generate a codemod itself. You may find that it's easier to tweak this, then run it as you would a normal codemod.

For instance, you can prompt the model with:

```js
/* A TypeScript Babel plugin. If it finds a function named `componentWillMount`, `componentWillReceiveProps`, or `componentWillUpdate`, it renames the function to be prefixed with `unsafe_`. */
```

And it'll return a plugin that looks like it basically does the right thing ([playground link](https://beta.openai.com/playground/p/aIiWGsn3gdp3OEdab1QTD9Lg?model=code-davinci-002)). You can then use that with [this codemod runner](../README.md#babel-plugin):

```
$ jscodemod --codemod from-openai.ts my/files/**.js
```

