export function load({ url }: { url: URL }) {
  return {
    email: url.searchParams.get('email') ?? '',
    token: url.searchParams.get('token') ?? '',
  }
}
