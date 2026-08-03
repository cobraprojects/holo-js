export default {
  apiVersion: 1,
  prepare(context) {
    const lifecycle = {
      command: context.run.command,
      kind: context.run.kind,
      changes: context.run.kind === 'incremental' ? context.run.changes : [],
      plugin: context.plugin.id,
    }

    return {
      kind: 'prepared',
      generatedArtifacts: [{
        path: 'lifecycle.json',
        contents: `${JSON.stringify(lifecycle, null, 2)}\n`,
      }],
      managedArtifacts: [{
        path: 'generated/generic-project-fixture.mjs',
        contents: "export const genericProjectFixture = 'ready'\n",
      }],
      watch: {
        roots: ['server/extensions'],
      },
    }
  },
}
