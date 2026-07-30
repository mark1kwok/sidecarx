/**
 * esbuild Configuration
 */

export default {
    entryPoints: ['./src/app.js'],
    bundle: true,
    minify: true,
    sourcemap: true,
    outfile: '../../release/admin/static/app.js',
    target: 'es2020',
    format: 'esm',
    define: {
        'process.env.NODE_ENV': '"production"'
    },
    // Inject polyfills if needed
    inject: [],
    // CDN modules — keep external, resolved at runtime via import map
    external: [
        'xterm',
        '@xterm/xterm',
        '@xterm/addon-fit',
        'monaco-editor',
        'https://cdn.jsdelivr.net/gh/lit/dist@3/core/lit-core.min.js',
    ],
};