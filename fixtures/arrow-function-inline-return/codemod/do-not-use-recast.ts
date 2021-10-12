import {Codemod} from '@nick.heiner/jscodemod';
import _ from 'lodash';
import * as BabelTypes from '@babel/types';
import type {Visitor} from '@babel/traverse';

// TODO is our intentional any type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TODO = any;

const codemod: Codemod = {
  getPlugin: () => ({
    plugin: ({types: t}: {types: typeof BabelTypes}): {visitor: Visitor<TODO>} =>
      ({
        visitor: {
          ArrowFunctionExpression(path) {
            if (t.isBlockStatement(path.node.body) && path.node.body.body.length === 1 &&
                  t.isReturnStatement(path.node.body.body[0])) {

              // I'm confident that this value will not be null, based on the runtime checks above.
              // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
              path.get('body').replaceWith(path.node.body.body[0].argument!);
            }
          },
          Literal(literalPath) {
          // This tests to make sure that getPlugin is called for each file, and is not reused between files.
            if (literalPath.node.type === 'StringLiteral') {
              literalPath.replaceWith(t.stringLiteral('new string literal'));
              literalPath.skip();
            }
          }
        }
      }),
    useRecast: false
  }),
  babelTransformOptions: {
    presets: ['@babel/preset-react', '@babel/preset-typescript', '@babel/preset-env']
  }
};

export default codemod;