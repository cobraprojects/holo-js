import { writeFileSync } from 'node:fs'
import { withHolo } from '@holo-js/adapter-next/config'

export default withHolo({
  webpack(config, { isServer }) {
    if (!isServer) {
      config.plugins.push({
        apply(compiler) {
          compiler.hooks.done.tap('BrowserDependencies', (stats) => {
            writeFileSync('browser-modules.json', JSON.stringify(stats.toJson({ all: false, modules: true, nestedModules: true, cachedModules: true, modulesSpace: Infinity, nestedModulesSpace: Infinity, groupModulesByPath: false, groupModulesByType: false, groupModulesByCacheStatus: false })))
          })
        },
      })
    }
    return config
  },
})
