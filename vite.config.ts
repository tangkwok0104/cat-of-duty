import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5177,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    // Justified oversize chunks (single-page 3D game, no routes to split):
    //  - main ~0.9 MB = three.js + postprocessing, all needed before first
    //    frame; textures/HDRI stream separately via the asset loader.
    //  - rapier ~2.2 MB = physics WASM inlined as base64 by the -compat
    //    build; already code-split behind a dynamic import so it parses in
    //    parallel with renderer startup.
    // Raise the advisory limit so real regressions (a new oversized chunk)
    // still warn instead of drowning in known noise.
    chunkSizeWarningLimit: 2400,
  },
  optimizeDeps: {
    // Rapier's compat build inlines its WASM as base64; excluding it from
    // pre-bundling avoids vite dev-server re-optimization stalls.
    exclude: ['@dimforge/rapier3d-compat'],
  },
});
