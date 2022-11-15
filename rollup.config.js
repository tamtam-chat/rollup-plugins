import typescript from '@rollup/plugin-typescript';
import nodeResolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';

/** @type {import('rollup').RollupOptions} */
export default {
    input: './src/index.ts',
    plugins: [nodeResolve(), commonjs(), typescript()],
    external: [/node_modules/],
    output: [{
        dir: './dist',
        format: 'es',
        entryFileNames: '[name].js'
    }, {
        dir: './dist',
        format: 'cjs',
        entryFileNames: '[name].cjs'
    }]
}
