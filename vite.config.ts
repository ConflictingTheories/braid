import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
    build: {
        lib: {
            entry: resolve(__dirname, 'src/index.ts'),
            name: 'Braid',
            fileName: 'braid',
            formats: ['es', 'cjs']
        },
        rollupOptions: {
            external: [],
            output: {
                globals: {}
            }
        },
        sourcemap: true,
        minify: false,
        declaration: true,
        declarationDir: 'dist'
    },
    resolve: {
        alias: {
            '@': resolve(__dirname, 'src')
        }
    }
});

