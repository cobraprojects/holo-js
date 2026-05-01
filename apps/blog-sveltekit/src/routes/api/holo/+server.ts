import { json } from '@sveltejs/kit'
import { holo } from '$lib/server/holo'

export async function GET() {
  const app = await holo.getApp()

  return json({
    ok: true,
    app: app.config.app.name,
    env: app.config.app.env,
    models: app.registry?.models.length ?? 0,
    commands: app.registry?.commands.length ?? 0,
  })
}
