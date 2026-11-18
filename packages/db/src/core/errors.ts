import { HOLO_FIELD_ERRORS, type HoloFieldErrors, type HoloFieldErrorsCarrier } from '@holo-js/kernel/field-errors'

export class DatabaseError extends Error {
  override readonly name: string
  readonly code: string
  override readonly cause?: unknown

  constructor(message: string, code = 'DATABASE_ERROR', cause?: unknown) {
    super(message)
    this.name = new.target.name
    this.code = code
    this.cause = cause
  }
}

export class ConfigurationError extends DatabaseError {
  constructor(message: string, cause?: unknown) {
    super(message, 'CONFIGURATION_ERROR', cause)
  }
}

export class CompilerError extends DatabaseError {
  constructor(message: string, cause?: unknown) {
    super(message, 'COMPILER_ERROR', cause)
  }
}

export class CapabilityError extends DatabaseError {
  constructor(message: string, cause?: unknown) {
    super(message, 'CAPABILITY_ERROR', cause)
  }
}

export class SecurityError extends DatabaseError {
  constructor(message: string, cause?: unknown) {
    super(message, 'SECURITY_ERROR', cause)
  }
}

export class SchemaError extends DatabaseError {
  constructor(message: string, cause?: unknown) {
    super(message, 'SCHEMA_ERROR', cause)
  }
}

export class RelationError extends DatabaseError {
  constructor(message: string, cause?: unknown) {
    super(message, 'RELATION_ERROR', cause)
  }
}

export class TransactionError extends DatabaseError {
  constructor(message: string, cause?: unknown) {
    super(message, 'TRANSACTION_ERROR', cause)
  }
}

export class HydrationError extends DatabaseError {
  constructor(message: string, cause?: unknown) {
    super(message, 'HYDRATION_ERROR', cause)
  }
}

export class ModelNotFoundException extends DatabaseError {
  readonly statusCode = 404
  readonly model: string

  constructor(model: string, message?: string, cause?: unknown) {
    super(message ?? `${model} not found.`, 'MODEL_NOT_FOUND', cause)
    this.model = model
  }
}

export class InvalidCursorException extends DatabaseError implements HoloFieldErrorsCarrier {
  declare readonly code: 'INVALID_CURSOR'
  readonly statusCode = 422
  readonly cursorName: string
  readonly errors: HoloFieldErrors

  constructor(cursorName: string, message = 'The cursor is invalid.', cause?: unknown) {
    super(message, 'INVALID_CURSOR', cause)
    this.cursorName = cursorName
    this.errors = Object.freeze({ [cursorName]: Object.freeze([message]) })
  }

  get [HOLO_FIELD_ERRORS](): HoloFieldErrors {
    return this.errors
  }
}

export class SerializationError extends DatabaseError {
  constructor(message: string, cause?: unknown) {
    super(message, 'SERIALIZATION_ERROR', cause)
  }
}
