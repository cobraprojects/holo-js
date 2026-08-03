export default {
  id: 'generic-project-fixture',
  name: 'Generic Project Fixture',
  contributes: {
    cli: {
      commands: './commands.mjs',
    },
    project: {
      prepare: './prepare.mjs',
    },
  },
}
