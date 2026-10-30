import { defineConfig } from 'vitest/config';

// Тесты только на моках: почта и бот подменены, сеть закрыта, порты не открываются (только inject).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup/no-network.ts'],
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Точки входа: только чтение настроек и listen/stdin, логика в покрытых модулях
      exclude: ['src/server.ts', 'src/cli.ts'],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
