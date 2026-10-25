import { fileURLToPath } from 'node:url';
import { main } from './main.js';

// Точка входа: единственный модуль, который что-то запускает при импорте.
// Корень проекта считается от этого файла (src/ или dist/), а не от текущей папки процесса.
// TODO(этап 2): загрузить .env через process.loadEnvFile с понятной ошибкой, если файла нет.
// TODO(этап 2): сохранить результат main и по SIGINT и SIGTERM вызвать stop.
const root = fileURLToPath(new URL('..', import.meta.url));

await main({ env: process.env, root });
