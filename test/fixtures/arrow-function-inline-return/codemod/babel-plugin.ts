import * as BabelTypes from '@babel/types';
import {Visitor} from '@babel/traverse';
import {TODO} from '../../../../types';

export default ({types: t}: {types: typeof BabelTypes}): {visitor: Visitor<TODO>} => 
  ({
    visitor: {
      ArrowFunctionExpression(path) {
        if (t.isBlockStatement(path.node.body) && path.node.body.body.length === 1 &&
                    t.isReturnStatement(path.node.body.body[0])) {
                	path.get('body').replaceWith(path.node.body.body[0].argument);  
        }
      }
    }
  });