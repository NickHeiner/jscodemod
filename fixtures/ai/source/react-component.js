class NameList extends React.Component {
  constructor(props) {
    super(props);
    this.state = {names: []};
  }

  componentDidMount() {
    console.log('mount side effect');
    this.timerID = setInterval(
      () => this.addName(),
      1000
    );
  }

  componentWillUnmount() {
    console.log('unmount side effect'); 
    clearInterval(this.timerID);
  }

  addName() {
      this.setState(({names}) => names.push(`name ${names.length}`))
  }

  render() {
    return (
      <div>
        <h1>Hello, world!</h1>
        <h2>Names: {this.state.names.join(',')}</h2>
      </div>
    );
  }
}