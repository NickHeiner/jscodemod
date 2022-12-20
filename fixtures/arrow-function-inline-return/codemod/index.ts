import {Codemod} from '@nick.heiner/jscodemod';
import _ from 'lodash';
import path from 'path';
import * as BabelTypes from '@babel/types';
import type {Visitor} from '@babel/traverse';

// TODO is our intentional any type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TODO = any;

const codemod: Codemod = {
  getPlugin: ({willNotifyOnAstChange, astDidChange, filePath}) => {
    if (process.env.CALL_WILL_NOTIFY_ON_AST_CHANGE) {
      willNotifyOnAstChange();
    }

    return ({types: t}: {types: typeof BabelTypes}): {visitor: Visitor<TODO>} => 
      ({
        visitor: {
          ArrowFunctionExpression(path) {
            if (t.isBlockStatement(path.node.body) && path.node.body.body.length === 1 &&
                  t.isReturnStatement(path.node.body.body[0])) {

              if (process.env.CALL_AST_DID_CHANGE) {
                astDidChange();
              }
    
              // I'm confident that this value will not be null, based on the runtime checks above.
              // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
              path.get('body').replaceWith(path.node.body.body[0].argument!);  
            }
          },
          Literal(literalPath) {
            // This tests to make sure that getPlugin is called for each file, and is not reused between files.
            if (literalPath.node.type === 'StringLiteral') {
              // This snippet works in the playground, but fails here. I don't know why.
              // https://www.typescriptlang.org/play?#code/JYWwDg9gTgLgBDAnmApnA3gNWAZ2DaAXzgDMoIQ4ByAAQCMBDOlAGwHoYoGA3FKHFFQDcAKFCRYcAFRwGOOACEmrACrIU8shWr1l7JKhzCRIgCYoAxiwZQ0FiADsc8GAC4E6iCUV61h0SL2TvDc7th4BFAAPAwOiAB8cAC8GCJw6XAAMvh8DCwAFCw5XCwACgwwABYAlKkZ9XBFMLllFZUAdLZg1hYoAOr4lfkw7c5QwA4A5tnNJflUcqYkVNXVaRmEIoRAA
              // @ts-expect-error
              literalPath.replaceWith(t.stringLiteral(path.basename(filePath)));
              literalPath.skip();
            }
          }
        }
      });
  },
  presets: ['@babel/preset-react', '@babel/preset-typescript', '@babel/preset-env']
};

export default codemod;