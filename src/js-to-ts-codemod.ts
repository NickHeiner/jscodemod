import type {AIChatCodemod} from './types';
import fs from 'fs/promises';
import path from 'path';
import execa from 'execa';

const codemod: AIChatCodemod = {
  getMessages: source => [
    {
      role: 'user',
      content:
        // eslint-disable-next-line max-len
        "In my next message, I'm going to give you some JavaScript. Convert it to TypeScript. If you're not sure what type to use, use `any`. Respond with only the code; do not include any other commentary."
    },
    {role: 'user', content: source}
  ],
  async postProcess(modifiedFiles) {
    for (const file of modifiedFiles) {
      const tsFileName = path.join(path.dirname(file), `${path.basename(file, '.js')}.ts`);
      await fs.rename(file, tsFileName);
      await execa('git', ['add', tsFileName, file]);
    }
  }
};

export default codemod;
