import { holo } from '@/server/holo'

export async function GET() {
  const app = await holo.getApp()

  return Response.json({
    ok: true,
    app: app.config.app.name,
    env: app.config.app.env,
    models: app.registry?.models.length ?? 0,
    commands: app.registry?.commands.length ?? 0,
  })
}
