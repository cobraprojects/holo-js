export class FormContractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FormContractError'
  }
}
