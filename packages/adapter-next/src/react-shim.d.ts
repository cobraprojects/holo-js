declare module 'react' {
  export type ReactNode = unknown
  export type Context<TValue> = {
    readonly Provider: (props: { readonly value: TValue, readonly children?: ReactNode }) => ReactNode
  }

  export function createContext<TValue>(defaultValue: TValue): Context<TValue>
  export function createElement(
    type: unknown,
    props: Record<string, unknown> | null,
    ...children: readonly ReactNode[]
  ): ReactNode
  export function cache<TFunction extends (...args: never[]) => unknown>(fn: TFunction): TFunction
  export function use<TValue>(value: PromiseLike<TValue>): TValue
  export function useCallback<TCallback extends (...args: never[]) => unknown>(
    callback: TCallback,
    deps: readonly unknown[],
  ): TCallback
  export function useContext<TValue>(context: Context<TValue>): TValue
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void
  export function useRef<TValue>(initialValue?: TValue): { current: TValue | undefined }
  export function useState<TValue>(
    initialState: TValue | (() => TValue),
  ): [TValue, (value: TValue | ((previous: TValue) => TValue)) => void]
  export function useSyncExternalStore<TSnapshot>(
    subscribe: (listener: () => void) => () => void,
    getSnapshot: () => TSnapshot,
    getServerSnapshot?: () => TSnapshot,
  ): TSnapshot
}
