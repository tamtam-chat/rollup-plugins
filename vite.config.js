/** @type {import('vite').UserConfig} */
export default {
    build: {
        outDir: './dist',
        assetsDir: '',
        sourcemap: true,
        lib: {
            entry: './src/index.ts',
            formats: ['es'],
            fileName: 'rollup-plugins'
        },
        rollupOptions: {
            external: [/node_modules/]
        }
    },
}
