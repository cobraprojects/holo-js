import { ValidationContractError } from './contracts-types'

type CurrentPasswordVerifier = (password: string, guard?: string) => Promise<boolean>

function runtime(): typeof globalThis & { __holoCurrentPasswordVerifier__?: CurrentPasswordVerifier } {
  return globalThis
}

export function setCurrentPasswordVerifier(verifier: CurrentPasswordVerifier | undefined): void {
  runtime().__holoCurrentPasswordVerifier__ = verifier
}

export async function validateCurrentPassword(value: unknown, guard: unknown): Promise<boolean> {
  const verifier = runtime().__holoCurrentPasswordVerifier__
  if (!verifier) {
    throw new ValidationContractError('currentPassword requires a configured server auth runtime.')
  }
  if (guard !== undefined && (typeof guard !== 'string' || !guard.trim())) {
    throw new ValidationContractError('currentPassword guard must be a non-empty string.')
  }
  return typeof value === 'string' && await verifier(value, guard)
}
