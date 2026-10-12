import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'

const RETYC_API_URL = process.env.RETYC_API_URL || 'https://api.retyc.com'

const rootDir = import.meta.dirname
const srcDir = resolve(rootDir, 'src')
const distDir = resolve(rootDir, 'dist')

// Generates dist/manifest.json with the correct host permission for the build-time API URL,
// and strips the "dist/" prefix from internal paths (since web-ext uses --source-dir=dist).
// Also copies assets/ into dist/assets/ so the packaged extension is self-contained.
function manifestPlugin(): Plugin {
  return {
    name: 'retyc-manifest',
    apply: 'build',
    closeBundle() {
      const src = JSON.parse(readFileSync(resolve(rootDir, 'manifest.json'), 'utf8'))

      // Strip "dist/" prefix — web-ext will source from dist/, so paths must be relative to it.
      const stripDist = (s: string) => s.replace(/^dist\//, '')
      src.background.page = stripDist(src.background.page)
      src.compose_action.default_popup = stripDist(src.compose_action.default_popup)
      src.browser_action.default_popup = stripDist(src.browser_action.default_popup)
      src.options_ui.page = stripDist(src.options_ui.page)

      // Replace the default API host permission with the build-time URL.
      const apiOrigin = new URL(RETYC_API_URL).origin + '/*'
      src.permissions = src.permissions
        .filter((p: string) => !/^https?:\/\/api\.retyc\.com/.test(p))
        .concat(apiOrigin)

      // No optional_permissions needed — the API URL is fixed at build time.
      delete src.optional_permissions

      writeFileSync(resolve(distDir, 'manifest.json'), JSON.stringify(src, null, 2))

      // Copy assets/ into dist/ so web-ext --source-dir=dist finds them.
      const assetsDir = resolve(rootDir, 'assets')
      if (existsSync(assetsDir)) {
        cpSync(assetsDir, resolve(distDir, 'assets'), { recursive: true })
      }
    },
  }
}

export default defineConfig(({ mode }) => ({
  root: srcDir,
  // Relative URLs: extension pages are served from moz-extension://<id>/, with or
  // without the "dist/" prefix depending on how the extension is loaded.
  base: './',
  publicDir: false,
  define: {
    __RETYC_API_URL__: JSON.stringify(RETYC_API_URL),
  },
  build: {
    outDir: distDir,
    emptyOutDir: true,
    target: 'firefox115',
    // Never use eval-based source maps: the extension CSP blocks `eval`.
    sourcemap: mode !== 'production',
    minify: mode === 'production',
    // The extension CSP only allows same-origin scripts, so no inline preload helper.
    modulePreload: false,
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        background: resolve(srcDir, 'background/background.html'),
        popup: resolve(srcDir, 'popup/popup.html'),
        'compose-popup': resolve(srcDir, 'compose-popup/compose-popup.html'),
        options: resolve(srcDir, 'options/options.html'),
        dialog: resolve(srcDir, 'dialog/dialog.html'),
      },
    },
  },
  plugins: [manifestPlugin()],
}))
