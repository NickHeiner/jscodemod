// I think it's getting confused with JSX.
// eslint-disable-next-line no-use-before-define
import React from 'react';

import {render, Text, Box} from 'ink';
import _ from 'lodash';

type FileListProps = {files: string[]};
const FileList = (props: FileListProps) => {
  const fileLimit = 10;
  const extraFiles = props.files.length - fileLimit;
  return <Box flexDirection='column'>
    {props.files.slice(0, fileLimit).map(file => <Text key={file}>{file}</Text>)}
    {extraFiles > 0 && <Text>({extraFiles} files not shown.)</Text>}
  </Box>;
};

export type DetectResults = {
  byLabel: Record<string, string[]>;
  errored: string[];
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

  return <Box>
    {
      _.map(props.detectResults.byLabel, (files, label) => 
        <Box flexDirection='column' key={label} paddingRight={5}>
          <Text>{label}</Text>
          <FileList files={files} />
        </Box>
      )
    }
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