import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['extension/core/**/*.test.js', 'eval/**/*.test.js'],
    exclude: ['extension/*.js'],
    // No passWithNoTests: tests exist now, so a run that collects nothing means
    // the include globs are broken and should fail loudly rather than pass.
  },
});
