export function load({ url }: { url: URL }) {
  return {
    token: url.searchParams.get('token') ?? '',
  }
}
