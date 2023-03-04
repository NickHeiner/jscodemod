import type { AIChatCodemod } from './types';
import fs from 'fs/promises';
import path from 'path';
import execa from 'execa';

const codemod: AIChatCodemod = {
  getMessages: source => [
    {
      role: 'user',
      content:
        // eslint-disable-next-line max-len
        "Convert this JS to TS. If you're not sure what type to use, use `any`. Preserve all comments. Do not make any changes to the code that aren't required for TS conversion. Respond with only the code; do not include any other commentary. Do not wrap the code in backticks.",
    },
    { role: 'user', content: source },
  ],
  async postProcess(modifiedFiles) {
    for (const file of modifiedFiles) {
      const tsFileName = path.join(path.dirname(file), `${path.basename(file, '.js')}.ts`);
      await fs.rename(file, tsFileName);
      await execa('git', ['add', tsFileName, file]);
    }
  },
};

export default codemod;
