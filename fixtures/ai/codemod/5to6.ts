import {AICodemod} from '../../..';

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
} satisfies AICodemod;

export default codemod;