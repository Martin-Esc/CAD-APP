import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths: the built app works from any folder or sub-path
  // (GitHub Pages serves it under /CAD-APP/, a lab server might use /cad/).
  base: './',
  build: {
    // three.js + the boolean kernel make one large chunk; that is expected
    chunkSizeWarningLimit: 1500,
  },
});
