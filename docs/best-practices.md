# Codemod Best Practices

## Do a few changes by hand first
Writing a codemod is an expensive upfront cost, so you want to make sure you're targeting the right thing. The best way to do this, and to become more familiar with the transform you're trying to do, is to do a few cases by hand first. For instance, if you're migrating an API call pattern from `f(a, b, c)` to `f({a, b, c})`, do a few by hand, to make sure it works. This will also help you learn about the different types of cases you want to transform.

## To maximize efficiency, consider ignoring edge cases
As you write your codemod, you'll find that the code you're transforming falls into different categories. For example, if you're transforming CommonJS to ESM, you might have categories like:

```js
// Category 1
const a = require('b');

// Category 2
const {a} = require('b');

// Category 3
const {a} = require('b').c;

// Category 4
const {a: {d}} = require('b').c;
```

These categories are not all created equal. Before handling a category in your codemod, ask yourself:

1. How long will it take to handle this category?
1. How many cases of this category exist in the codebase?

For small or tricky categories, it may be more efficient to just migrate them by hand.

In general: it's easy to waste time with codemods if you're aiming for perfection. But that's rarely the goal. This is a transform you're running one time. You're using it to help you save typing. It's ok to be scrappy.

## Incrementalism can be better
Because you can run a codemod on the entire codebase at once, it's tempting to aim for a one-shot migration. For simple changes, this is fine. But for more complicated changes, consider applying the codemod in chunks, where each commit only changes a handful of files. 

Benefits to this include:
1. Lower risk of having to revert your entire migration, because each change is smaller. If you have to revert your entire migration, then re-apply it later, you can cause a lot of git merge pain for other people working in the codebase.
1. If you have a complicated codemod in a large codebase with many committers, you can end up playing whackamole, where you fix some edge case, only to see new ones emerge. If you commit the codemod results in chunks, then there's no whackamole, because once a codebase section is transformed, it's permanently removed from your input set.
1. If your codemod handles some input code cases but not all, you can start making migration progress before reaching 100% coverage. Just apply the codemod to the cases it can handle already.
1. Applying the codemod in chunks lets you learn as you go, and possibly tweak the codemod in response to feedback. A single-shot migration doesn't give you that opportunity.

## If your codemod is for a single repo, check it in to that repo.
This maximizes historical context for later devs. It also gives other devs the ability to run your codemod against their branches, which may be an easier way to resolve merge conflicts than hand editing. And, if you make more codemods later, you'll often find that there are bits to copy/paste or share with older codemods.

The downside is that it's annoying to have test/lint/typecheck failures on code that's not actively run. If that happens, you can just comment out or delete the codemod at that point.

