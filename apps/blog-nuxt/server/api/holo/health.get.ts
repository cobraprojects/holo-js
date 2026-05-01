export default defineEventHandler(async () => {
  const app = await holo.getApp()

  return {
    ok: true,
    app: app.config.app.name,
    env: app.config.app.env,
    models: app.registry?.models.length ?? 0,
    commands: app.registry?.commands.length ?? 0,
  }
})
