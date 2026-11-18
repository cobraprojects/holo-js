declare const __HOLO_APP_BASE__: string | undefined

export function appPath(path: string): string {
  return `${typeof __HOLO_APP_BASE__ === 'string' ? __HOLO_APP_BASE__ : ''}${path}`
}

export { requestAppBaseInternals } from './requestAppBase'
