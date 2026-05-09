type RequestAccessBindings = {
  readonly context: {
    getRequestCookie?(name: string): Promise<string | undefined> | string | undefined
    getRequestHeader?(name: string): Promise<string | undefined> | string | undefined
    appendResponseCookie?(cookie: string): Promise<void> | void
  }
}

export async function resolveRequestCookie(
  bindings: RequestAccessBindings,
  name: string,
): Promise<string | undefined> {
  return await bindings.context.getRequestCookie?.(name)
}

export async function resolveRequestHeader(
  bindings: RequestAccessBindings,
  name: string,
): Promise<string | undefined> {
  const value = await bindings.context.getRequestHeader?.(name)
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export async function appendResponseCookies(
  bindings: RequestAccessBindings,
  cookies: readonly string[],
): Promise<void> {
  if (!bindings.context.appendResponseCookie) {
    return
  }

  for (const cookie of cookies) {
    await bindings.context.appendResponseCookie(cookie)
  }
}

export function parseBearerToken(header: string | undefined): string | undefined {
  if (typeof header !== 'string') {
    return undefined
  }

  const match = header.match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() || undefined
}
