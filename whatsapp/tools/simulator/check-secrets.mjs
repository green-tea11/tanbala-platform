// Проверка вывода на утечку секретов: печатает только число найденных совпадений, не значения.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const botRoot = process.argv[2];
const outRoot = process.argv[3];
const { loadEnvironment } = await import(pathToFileURL(join(botRoot, 'dist', 'config', 'dotenv.js')).href);
const env = loadEnvironment(botRoot, {});
const secrets = Object.entries(env)
  .filter(([name, value]) => /(KEY|TOKEN|PASSWORD|SECRET)(?!.*_(PATH|DIR|URL|PORT|HOST)$)/i.test(name) && typeof value === 'string' && value.trim().length >= 6)
  .map(([name, value]) => [name, value.trim()]);
console.log(`секретов в .env: ${secrets.length} (${secrets.map(([n]) => n).join(', ')})`);
let hits = 0;
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) { walk(path); continue; }
    const text = readFileSync(path, 'utf8');
    for (const [envName, value] of secrets) if (text.includes(value)) { hits += 1; console.log(`УТЕЧКА: ${envName} в ${path}`); }
    if (/sk-ant-[A-Za-z0-9_-]{8,}/.test(text)) { hits += 1; console.log(`похожее на ключ в ${path}`); }
  }
};
walk(outRoot);
console.log(`совпадений: ${hits}`);
