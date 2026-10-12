import { SecurityError } from '../core/errors'

export class NumericAdjustment {
  constructor(readonly amount: number) {
    if (typeof amount !== 'number' || !Number.isFinite(amount)) {
      throw new SecurityError('Increment/decrement amount must be a valid number.')
    }
    Object.freeze(this)
  }
}
