import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/hono.ts',
    'src/fastify.ts',
    'src/koa.ts',
    'src/next.ts',
    'src/elysia.ts'
  ],
  format: ['cjs', 'esm'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  external: ['hono', 'fastify', 'koa', 'next', 'elysia'],
});