declare module 'react' {
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void
  export function useRef<TValue>(initialValue?: TValue): { current: TValue | undefined }
  export function useState<TValue>(
    initialState: TValue | (() => TValue),
  ): [TValue, (value: TValue | ((previous: TValue) => TValue)) => void]
}
