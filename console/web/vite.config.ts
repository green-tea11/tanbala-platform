import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { mockApi } from './mock/plugin';

// Разработка: без CONSOLE_PROXY страница ходит в заглушки mock/ (данные по contract/CONSOLE_API.md и docs/API.md);
// с CONSOLE_PROXY=http://127.0.0.1:3200 — в настоящий сервер консоли. В сборку заглушки не попадают.
const proxyTarget = process.env['CONSOLE_PROXY'];

export default defineConfig({
  plugins: [react(), ...(proxyTarget ? [] : [mockApi()])],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    ...(proxyTarget ? { proxy: { '/api': { target: proxyTarget, changeOrigin: false } } } : {}),
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    // Без встраивания картинок и шрифтов в data: — CSP консоли пускает только свои файлы.
    assetsInlineLimit: 0,
    sourcemap: false,
  },
});
