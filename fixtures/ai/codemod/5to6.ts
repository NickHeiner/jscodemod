import {AICodemod} from '../../..';

const codemod = {
  getCompletionRequestParams({source}) {
    return {
      model: 'gpt-3.5-turbo',
      prompt: `
        ${source}

        /* The Javascript code above is written in ES5. Transform it to ES6. Include only the transformed code; do not include any other comments, context, or metadata. Do not create new comments. Make sure to apply the following transformations: 1. Use optional chaining. 2. Use the object property shorthand. */
      `
    }
  },
} satisfies AICodemod;

export default codemod;