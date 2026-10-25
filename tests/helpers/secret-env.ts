/** Переменные с ключами API: в тестах их быть не должно, даже если они есть у разработчика. */
function isSecretName(name: string): boolean {
  // На Windows имена переменных окружения не зависят от регистра
  return /^(?:ANTHROPIC_|VENMART_ANTHROPIC_KEY$|OPENROUTER_API_KEY$)/i.test(name);
}

/** Удаляет ключи API из переданного окружения (обычно process.env) и возвращает их имена. */
export function scrubSecretEnv(env: NodeJS.ProcessEnv): string[] {
  const removed = Object.keys(env).filter(isSecretName);
  for (const name of removed) {
    delete env[name];
  }
  return removed;
}
