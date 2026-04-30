export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { holo } = await import('@/server/holo')
    await holo.getApp()
  }
}
