export class RealtimeError extends Error {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options)
    this.name = 'RealtimeError'
  }
}

export class RealtimeUnauthorizedError extends RealtimeError {
  constructor(message = 'Realtime access denied.') {
    super(message)
    this.name = 'RealtimeUnauthorizedError'
  }
}

export class RealtimeForbiddenError extends RealtimeError {
  constructor(message = 'Realtime access forbidden.') {
    super(message)
    this.name = 'RealtimeForbiddenError'
  }
}

export class RealtimeAuthUnavailableError extends RealtimeError {
  constructor(
    message = 'Realtime authenticated access requires @holo-js/auth to be installed and configured.',
    options: ErrorOptions = {},
  ) {
    super(message, options)
    this.name = 'RealtimeAuthUnavailableError'
  }
}
