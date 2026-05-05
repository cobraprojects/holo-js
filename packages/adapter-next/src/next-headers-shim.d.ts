declare module 'next/headers' {
  export function cookies(): Promise<{
    get(name: string): {
      readonly value: string
    } | undefined
  }>

  export function headers(): Promise<Headers>
}
