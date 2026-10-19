import type { Socket } from 'node:net'

function isUnixSocket(socket: Socket): boolean {
  return !socket.destroyed && Object.keys(socket.address()).length === 0
}

export function connectionAddress(socket: Socket): string | undefined {
  if (socket.remoteAddress) return socket.remoteAddress
  return isUnixSocket(socket) ? '127.0.0.1' : undefined
}
