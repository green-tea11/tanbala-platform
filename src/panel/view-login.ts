import { markup } from './html.js';
import { renderLayout } from './layout.js';

/** Страница входа; error: причина отказа над формой (неверный пароль, слишком много попыток). */
export function renderLoginPage(error: string | null): string {
  return renderLayout({
    title: 'Вход',
    body: markup`<section class="login">
<h1>Вход в панель Tanbala</h1>
${error === null ? null : markup`<p class="alert" role="alert">${error}</p>`}
<form method="post" action="/login">
<label for="password">Пароль</label>
<input id="password" type="password" name="password" autocomplete="current-password" required autofocus>
<button type="submit">Войти</button>
</form>
</section>`,
  });
}
