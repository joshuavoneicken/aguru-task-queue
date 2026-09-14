import '@testing-library/jest-dom/vitest';

// jsdom has no canvas: return null quietly (components guard for it) instead of
// letting jsdom log "Not implemented" on every <canvas> effect.
Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  value: () => null,
  configurable: true,
});
