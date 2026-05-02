const fs = require('fs')
const path = require('path')
const webpack = require('webpack')
const HtmlWebpackPlugin = require('html-webpack-plugin')
const MiniCssExtractPlugin = require('mini-css-extract-plugin')

const RETYC_API_URL = process.env.RETYC_API_URL || 'https://api.retyc.com'

// Generates dist/manifest.json with the correct host permission for the build-time API URL,
// and strips the "dist/" prefix from internal paths (since web-ext uses --source-dir=dist).
// Also copies assets/ into dist/assets/ so the packaged extension is self-contained.
class ManifestPlugin {
  apply(compiler) {
    compiler.hooks.afterEmit.tapAsync('ManifestPlugin', (_compilation, callback) => {
      try {
        const src = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'manifest.json'), 'utf8'))

        // Strip "dist/" prefix — web-ext will source from dist/, so paths must be relative to it.
        const stripDist = (s) => s.replace(/^dist\//, '')
        src.background.scripts = src.background.scripts.map(stripDist)
        src.compose_action.default_popup = stripDist(src.compose_action.default_popup)
        src.browser_action.default_popup = stripDist(src.browser_action.default_popup)
        src.options_ui.page = stripDist(src.options_ui.page)

        // Replace the default API host permission with the build-time URL.
        const apiOrigin = new URL(RETYC_API_URL).origin + '/*'
        src.permissions = src.permissions
          .filter(p => !/^https?:\/\/api\.retyc\.com/.test(p))
          .concat(apiOrigin)

        // No optional_permissions needed — the API URL is fixed at build time.
        delete src.optional_permissions

        fs.writeFileSync(
          path.resolve(__dirname, 'dist/manifest.json'),
          JSON.stringify(src, null, 2),
        )

        // Copy assets/ into dist/ so web-ext --source-dir=dist finds them.
        const assetsDir = path.resolve(__dirname, 'assets')
        if (fs.existsSync(assetsDir)) {
          fs.cpSync(assetsDir, path.resolve(__dirname, 'dist/assets'), { recursive: true })
        }

        callback()
      } catch (err) {
        callback(err)
      }
    })
  }
}

/** @type {import('webpack').Configuration} */
module.exports = (env, argv) => ({
  devtool: argv.mode === 'production' ? false : 'cheap-module-source-map',
  entry: {
    background: './src/background/index.ts',
    popup: './src/popup/popup.ts',
    'compose-popup': './src/compose-popup/compose-popup.ts',
    options: './src/options/options.ts',
    dialog: './src/dialog/dialog.ts',
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js',
    clean: true,
  },
  resolve: {
    extensions: ['.ts', '.js'],
    fallback: {
      buffer: require.resolve('buffer/'),
      stream: require.resolve('stream-browserify'),
      path: require.resolve('path-browserify'),
      fs: false,
      crypto: false,
      util: false,
      assert: false,
    },
    alias: {
      // The SDK's package.json declares index.mjs in exports but only ships index.cjs — use CJS
      '@retyc/sdk': path.resolve(__dirname, 'node_modules/@retyc/sdk/dist/index.cjs'),
      'node:buffer': require.resolve('buffer/'),
      'node:stream': require.resolve('stream-browserify'),
      'node:path': require.resolve('path-browserify'),
      'node:fs': false,
      'node:crypto': false,
      'node:util': false,
    },
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: [{ loader: 'ts-loader', options: { transpileOnly: true } }],
        exclude: /node_modules/,
      },
      {
        test: /\.css$/,
        use: [MiniCssExtractPlugin.loader, 'css-loader'],
      },
    ],
  },
  plugins: [
    new webpack.DefinePlugin({
      __RETYC_API_URL__: JSON.stringify(RETYC_API_URL),
    }),
    new webpack.ProvidePlugin({
      Buffer: ['buffer', 'Buffer'],
      process: 'process/browser',
    }),
    new MiniCssExtractPlugin({ filename: '[name].css' }),
    new HtmlWebpackPlugin({
      template: './src/popup/popup.html',
      filename: 'popup.html',
      chunks: ['popup'],
      inject: 'body',
    }),
    new HtmlWebpackPlugin({
      template: './src/compose-popup/compose-popup.html',
      filename: 'compose-popup.html',
      chunks: ['compose-popup'],
      inject: 'body',
    }),
    new HtmlWebpackPlugin({
      template: './src/options/options.html',
      filename: 'options.html',
      chunks: ['options'],
      inject: 'body',
    }),
    new HtmlWebpackPlugin({
      template: './src/dialog/dialog.html',
      filename: 'dialog.html',
      chunks: ['dialog'],
      inject: 'body',
    }),
    new ManifestPlugin(),
  ],
  // Silence warnings for SDK Node.js shims
  ignoreWarnings: [
    /Critical dependency/,
    /Module not found.*node:/,
  ],
})
