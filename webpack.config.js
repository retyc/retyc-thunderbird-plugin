const path = require('path')
const webpack = require('webpack')
const HtmlWebpackPlugin = require('html-webpack-plugin')
const MiniCssExtractPlugin = require('mini-css-extract-plugin')

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
  ],
  // Silence warnings for SDK Node.js shims
  ignoreWarnings: [
    /Critical dependency/,
    /Module not found.*node:/,
  ],
})
