/**
 * Стили панели отдельным файлом /panel.css: CSP не пускает inline-стили и скрипты. Внешних адресов (шрифты,
 * картинки, @import) нет: панель работает без сети и ничего не загружает из чужих мест.
 */
export const PANEL_CSS = `:root {
  --bg: #f5f6f8;
  --card: #ffffff;
  --text: #1d2330;
  --muted: #5b6475;
  --line: #dfe3ea;
  --accent: #1f4fc9;
  --secondary: #475467;
  --danger-bg: #fee4e2;
  --danger-text: #912018;
  --ok-bg: #d1fadf;
  --ok-text: #054f31;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}

a {
  color: var(--accent);
}

main {
  max-width: 1040px;
  margin: 0 auto;
  padding: 24px;
}

h1 {
  margin: 0 0 8px;
  font-size: 1.6rem;
}

h2 {
  margin: 24px 0 8px;
  font-size: 1.15rem;
}

.top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 24px;
  padding: 12px 24px;
  background: var(--card);
  border-bottom: 1px solid var(--line);
}

.top nav {
  display: flex;
  flex: 1;
  flex-wrap: wrap;
  gap: 8px 20px;
}

.top nav a[aria-current="page"],
.filters a[aria-current="page"] {
  color: var(--text);
  font-weight: 700;
  text-decoration: none;
}

.brand {
  font-weight: 700;
}

.muted {
  color: var(--muted);
  font-size: 0.9rem;
}

.empty {
  padding: 24px 0;
  color: var(--muted);
}

.filters {
  display: flex;
  gap: 16px;
  margin: 12px 0;
}

table {
  width: 100%;
  border-collapse: collapse;
  background: var(--card);
  border: 1px solid var(--line);
}

th,
td {
  padding: 10px 12px;
  border-bottom: 1px solid var(--line);
  text-align: left;
  vertical-align: top;
}

th {
  color: var(--muted);
  font-size: 0.85rem;
  font-weight: 600;
}

.badge {
  display: inline-block;
  padding: 1px 10px;
  border-radius: 999px;
  background: #eef0f4;
  font-size: 0.85rem;
}

.level-hot {
  background: #fee4e2;
  color: #912018;
}

.level-warm {
  background: #fef0c7;
  color: #93370d;
}

.level-cold {
  background: #e0eaff;
  color: #1849a9;
}

.status-manager {
  background: var(--ok-bg);
  color: var(--ok-text);
}

.card {
  margin: 16px 0;
  padding: 4px 16px 16px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 8px;
}

.facts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 6px 20px;
  margin: 0;
}

.facts dt {
  color: var(--muted);
}

.facts dd {
  margin: 0;
  overflow-wrap: anywhere;
}

.messages {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.msg {
  max-width: 80%;
  padding: 8px 12px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 12px;
}

.msg-client {
  align-self: flex-start;
}

.msg-bot,
.msg-human_phone,
.msg-human_panel {
  align-self: flex-end;
  background: #e8f0ff;
}

.msg .meta {
  color: var(--muted);
  font-size: 0.8rem;
}

.msg .text,
.note {
  margin: 0;
  font: inherit;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

form label {
  display: block;
  margin-bottom: 4px;
  font-weight: 600;
}

textarea,
input[type="password"] {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  font: inherit;
}

button {
  margin-top: 8px;
  padding: 8px 18px;
  border: 0;
  border-radius: 8px;
  background: var(--accent);
  color: #ffffff;
  font: inherit;
  cursor: pointer;
}

button.secondary {
  background: var(--secondary);
}

button.link {
  margin: 0;
  padding: 0;
  background: none;
  color: var(--accent);
  text-decoration: underline;
}

.alert,
.notice {
  margin: 12px 0;
  padding: 10px 12px;
  border-radius: 8px;
}

.alert {
  background: var(--danger-bg);
  color: var(--danger-text);
}

.notice {
  background: var(--ok-bg);
  color: var(--ok-text);
}

.pager {
  display: flex;
  align-items: center;
  gap: 16px;
  margin: 16px 0;
}

.login {
  max-width: 360px;
  margin: 10vh auto 0;
}

@media (max-width: 640px) {
  main {
    padding: 16px;
  }

  .msg {
    max-width: 95%;
  }

  .facts {
    grid-template-columns: 1fr;
  }
}
`;
