// I think it's getting confused with JSX.
// eslint-disable-next-line no-use-before-define
import React from 'react';

import {render, Text, Box, Spacer} from 'ink';

export type DetectResults = {
  matching: string[],
  notMatching: string[],
  errored: string[]
}
export type Phase = 'reacting' | 'showing-results'
type Props = {
  phase: 'reacting';
} | {
  phase: 'showing-results';
  detectResults: DetectResults
}

const App = (props: Props) => {
  if (props.phase === 'reacting') {
    return <Text>Compiling and scanning...</Text>;
  }

  return <Box flexDirection='column'>
    <Text>{props.detectResults.matching.length} matching files.</Text>
    <Spacer />
    <Text>{props.detectResults.notMatching.length} not matching files.</Text>
  </Box>;
};

type InteractiveUI = {
  showReacting: () => void;
  showDetectResults: (detectResults: DetectResults) => void;
}

const makeInteractiveUI = (): InteractiveUI => {
  const {rerender} = render(<App phase='reacting' />);

  const showReacting = () => {
    rerender(<App phase='reacting' />);
  };

  const showDetectResults = (detectResults: DetectResults) => {
    rerender(<App phase='showing-results' detectResults={detectResults} />);
  };

  return {
    showReacting, showDetectResults
  };
};

export default makeInteractiveUI;