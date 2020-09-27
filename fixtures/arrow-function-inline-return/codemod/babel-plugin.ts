import * as BabelTypes from '@babel/types';
import {Visitor} from '@babel/traverse';

// TODO is our intentional any type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TODO = any;

export default ({types: t}: {types: typeof BabelTypes}): {visitor: Visitor<TODO>} => 
  ({
    visitor: {
      ArrowFunctionExpression(path) {
        if (t.isBlockStatement(path.node.body) && path.node.body.body.length === 1 &&
              t.isReturnStatement(path.node.body.body[0])) {

          // I'm confident that this value will not be null, based on the runtime checks above.
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          path.get('body').replaceWith(path.node.body.body[0].argument!);  
        }
      }
    }
  });