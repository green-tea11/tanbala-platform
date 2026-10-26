import { describe, expect, it } from 'vitest';
import { cleanText, escapeHtml, markup, raw, SafeHtml } from '../../../src/panel/html.js';

describe('escapeHtml', () => {
  it('заменяет пять опасных символов', () => {
    expect(escapeHtml(`<script>alert("x") & 'y'</script>`)).toBe(
      '&lt;script&gt;alert(&quot;x&quot;) &amp; &#39;y&#39;&lt;/script&gt;',
    );
  });

  it('обычный текст, кириллица и эмодзи не меняются', () => {
    expect(escapeHtml('Здравствуйте! Нужен учёт 😀')).toBe('Здравствуйте! Нужен учёт 😀');
  });

  it('уже экранированное экранируется ещё раз: текст показывается как написан', () => {
    expect(escapeHtml('&lt;b&gt;')).toBe('&amp;lt;b&amp;gt;');
  });
});

describe('markup', () => {
  it('экранирует строки и числа, шаблонный текст оставляет как есть', () => {
    const fragment = markup`<p class="note">${'<b>имя</b>'} и ${42}</p>`;

    expect(fragment).toBeInstanceOf(SafeHtml);
    expect(fragment.value).toBe('<p class="note">&lt;b&gt;имя&lt;/b&gt; и 42</p>');
  });

  it('собственные фрагменты не экранируются повторно, в том числе в массивах', () => {
    const items = ['a', '<b>'].map((item) => markup`<li>${item}</li>`);

    expect(markup`<ul>${items}</ul>`.value).toBe('<ul><li>a</li><li>&lt;b&gt;</li></ul>');
  });

  it('null, undefined и булевы значения ничего не выводят: условный вывод', () => {
    const flag = false as boolean;

    expect(markup`[${null}${undefined}${flag}${true}${flag && markup`<i>x</i>`}]`.value).toBe('[]');
    expect(markup`${flag ? markup`<i>да</i>` : null}`.value).toBe('');
  });

  it('кавычки в значении атрибута не выходят за него', () => {
    const attack = '" onmouseover="alert(1)';

    expect(markup`<a title="${attack}">x</a>`.value).toBe(
      '<a title="&quot; onmouseover=&quot;alert(1)">x</a>',
    );
  });

  it('вложенные массивы раскрываются', () => {
    expect(markup`${[['a', ['b']], 'c']}`.value).toBe('abc');
  });
});

describe('raw', () => {
  it('помечает свою константу как безопасную: её не экранируют', () => {
    expect(markup`${raw('<br>')}`.value).toBe('<br>');
  });
});

describe('cleanText', () => {
  it('убирает управляющие символы и переопределение направления текста, оставляя переводы строк', () => {
    const dirty = 'до\u0000\u0007\u001b после‮обратно⁦x⁩\u007f\u0085';

    expect(cleanText(dirty)).toBe('до послеобратноx');
    expect(cleanText('строка 1\nстрока 2\tтаб\r\nстрока 3')).toBe(
      'строка 1\nстрока 2\tтаб\r\nстрока 3',
    );
  });

  it('обычный текст с эмодзи и составными символами не меняется', () => {
    expect(cleanText('Привет 👩‍💻 ё')).toBe('Привет 👩‍💻 ё');
  });
});
