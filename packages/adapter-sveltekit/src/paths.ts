export function appPathname(pathname: string, base: string): string {
  if (!base) return pathname
  if (pathname === base) return '/'
  return pathname.startsWith(`${base}/`) ? pathname.slice(base.length) : pathname
}

export function withBase(path: string, base: string): string {
  return `${base}${path}`
}
