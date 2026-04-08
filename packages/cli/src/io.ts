export function writeLine(stream: NodeJS.WriteStream, message = ''): void {
  stream.write(`${message}\n`)
}
