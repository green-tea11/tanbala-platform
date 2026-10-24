/* Tanbala · поиск клиентов. Небольшие улучшения поверх обычных форм: без скрипта всё тоже работает.
   Данные с сервера выводятся только через textContent, никогда через innerHTML. */
(function () {
  "use strict";

  var TONES = ["neutral", "accent", "pos", "neg"];
  var MAX_RETRY_MS = 30000;
  var numbers = new Intl.NumberFormat("ru-RU");

  function onReady(fn) {
    if (document.readyState !== "loading") fn();
    else document.addEventListener("DOMContentLoaded", fn);
  }

  function each(root, selector, fn) {
    Array.prototype.forEach.call(root.querySelectorAll(selector), fn);
  }

  /* ---------- несколько отраслей: те же правила, что в pipeline.split_queries и create_run ---------- */

  var INDUSTRY_FORMS = ["отрасль", "отрасли", "отраслей"];
  var UP_TO_COMPANY_FORMS = ["компании", "компаний", "компаний"];

  function pluralRu(number, forms) {
    var n = Math.abs(number) % 100;
    if (n >= 11 && n <= 14) return forms[2];
    if (n % 10 === 1) return forms[0];
    if (n % 10 >= 2 && n % 10 <= 4) return forms[1];
    return forms[2];
  }

  /* Отрасли из поля: через запятую, точку с запятой или с новой строки, без повторов. */
  function splitIndustries(text) {
    var found = [];
    var seen = {};
    String(text || "").split(/[,;\n]+/).forEach(function (part) {
      var query = part.split(/\s+/).filter(Boolean).join(" ");
      var key = query.toLowerCase();
      if (query && !seen[key]) {
        seen[key] = true;
        found.push(query);
      }
    });
    return found;
  }

  /* Кнопка-подсказка: добавить отрасль в список или убрать, если она уже есть. Поле не заменяется. */
  function toggleIndustry(text, industry) {
    var current = splitIndustries(text);
    var key = industry.toLowerCase();
    var kept = current.filter(function (query) { return query.toLowerCase() !== key; });
    return (kept.length < current.length ? kept : current.concat([industry])).join(", ");
  }

  /* Одна значащая цифра, как format_approx_usd на сервере: $0,05, $0,3, $1. */
  function approxUsd(value) {
    if (!(value > 0)) return "$0";
    var exponent = Math.floor(Math.log10(value));
    var step = Math.pow(10, exponent);
    var rounded = Math.round(value / step) * step;
    return "$" + String(Number(rounded.toFixed(Math.max(0, -exponent)))).replace(".", ",");
  }

  function estimateText(count, perIndustry, limits) {
    if (count < 1 || perIndustry < 1) return "";
    var total = count * perIndustry;
    var usd = approxUsd(total * limits.per_company_usd + limits.first_run_usd);
    return count + " " + pluralRu(count, INDUSTRY_FORMS) + " × " + perIndustry + " = до " + total + " " +
      pluralRu(total, UP_TO_COMPANY_FORMS) + " · примерно " + usd;
  }

  /* Что не пропустит сервер: сказать сразу, до нажатия. Пустая строка: всё в порядке. */
  function limitError(industries, perIndustry, limits) {
    var count = industries.length;
    if (count > limits.max_queries) {
      return "Не больше " + limits.max_queries + " отраслей за один запуск, сейчас " + count + ".";
    }
    var tooLong = industries.filter(function (query) { return query.length > limits.max_query_length; })[0];
    if (tooLong) return "Запрос «" + tooLong.slice(0, 30) + "…» длиннее " + limits.max_query_length + " символов.";
    if (perIndustry > limits.max_per) return "На отрасль можно от 1 до " + limits.max_per + " компаний.";
    if (count * perIndustry > limits.max_total) {
      return "За один запуск не больше " + limits.max_total + " компаний: " + count + " " +
        pluralRu(count, INDUSTRY_FORMS) + " × " + perIndustry + " = " + count * perIndustry +
        ". Уменьшите число компаний на отрасль.";
    }
    return "";
  }

  window.TanbalaSearch = {
    splitIndustries: splitIndustries, toggleIndustry: toggleIndustry, approxUsd: approxUsd,
    estimateText: estimateText, limitError: limitError
  };

  /* Кнопка «Найти компании» выключена, пока идёт другой запуск (data-busy) или нарушен лимит (data-invalid). */
  function refreshStart() {
    var button = document.getElementById("start-button");
    if (!button) return;
    button.disabled = button.getAttribute("data-busy") === "true" || button.getAttribute("data-invalid") === "true";
  }

  /* Отрасли, число на отрасль, живая строка «3 отрасли × 5 = до 15 компаний · примерно $0,05» и лимиты. */
  function setupSearchForm() {
    var input = document.getElementById("query");
    var count = document.getElementById("max_companies");
    var line = document.getElementById("run-estimate");
    var warning = document.getElementById("run-limit");
    var button = document.getElementById("start-button");
    if (!input || !count || !line || !warning || !button) return;
    var limits;
    try {
      limits = JSON.parse(line.getAttribute("data-limits") || "{}");
    } catch (error) {
      return;
    }

    function update() {
      var industries = splitIndustries(input.value);
      var perIndustry = parseInt(count.value, 10) || 0;
      var keys = industries.map(function (query) { return query.toLowerCase(); });
      each(document, "[data-query]", function (chip) {
        chip.setAttribute("aria-pressed", String(keys.indexOf(chip.getAttribute("data-query").toLowerCase()) >= 0));
      });
      var problem = limitError(industries, perIndustry, limits);
      line.textContent = estimateText(industries.length, perIndustry, limits);
      warning.textContent = problem;
      warning.hidden = !problem;
      button.setAttribute("data-invalid", problem ? "true" : "false");
      refreshStart();
    }

    each(document, "[data-query]", function (chip) {
      chip.setAttribute("role", "button");
      chip.addEventListener("click", function (event) {
        event.preventDefault();
        input.value = toggleIndustry(input.value, chip.getAttribute("data-query"));
        update();
      });
    });
    input.addEventListener("input", update);
    count.addEventListener("input", update);
    update();
  }

  /* Кнопка запуска: защита от двойного нажатия. После «назад» в браузере кнопка снова как была. */
  function setupSearchSubmit() {
    var form = document.getElementById("search-form");
    var button = document.getElementById("start-button");
    if (!form || !button) return;
    var label = button.textContent;
    form.addEventListener("submit", function () {
      window.setTimeout(function () {
        button.disabled = true;
        button.textContent = "Запускаю…";
      }, 0);
    });
    window.addEventListener("pageshow", function (event) {
      if (!event.persisted) return;
      button.textContent = label;
      refreshStart();
    });
  }

  function enableStart() {
    var button = document.getElementById("start-button");
    var busy = document.getElementById("busy-note");
    if (button) {
      button.removeAttribute("data-busy");
      button.removeAttribute("aria-describedby");
      refreshStart();
    }
    if (busy) busy.hidden = true;
  }

  function noop() {}

  /* Значок на вкладке «Письма»: сколько писем ждут проверки. */
  function updateBadge(count) {
    var badge = document.querySelector("[data-letters-badge]");
    if (!badge || typeof count !== "number") return;
    badge.textContent = numbers.format(count);
    badge.hidden = count === 0;
  }

  /* Опрос /api/runs/<id>, пока запуск не закончится. 404: запуска нет, опрос прекращается. */
  function pollRun(runId, interval, handlers) {
    var failures = 0;

    function schedule(ms) {
      window.setTimeout(tick, ms);
    }

    function tick() {
      fetch("/api/runs/" + encodeURIComponent(runId), {
        headers: { Accept: "application/json" },
        cache: "no-store",
        credentials: "same-origin"
      })
        .then(function (response) {
          if (response.status === 404) return null;
          if (!response.ok) throw new Error("HTTP " + response.status);
          return response.json();
        })
        .then(function (run) {
          failures = 0;
          if (run === null) {
            handlers.onGone();
            return;
          }
          handlers.onUpdate(run);
          if (run.finished) handlers.onFinish(run);
          else schedule(interval);
        })
        .catch(function () {
          failures += 1;
          handlers.onError();
          schedule(Math.min(interval * Math.pow(2, failures), MAX_RETRY_MS));
        });
    }

    schedule(interval);
  }

  /* Счётчики, статус и расход: одинаково в панели запуска и в его строке «Прошлых запусков». */
  function applyCommon(root, run) {
    var status = root.querySelector("[data-run-field='status_label']");
    if (status && typeof run.status_label === "string") {
      status.textContent = run.status_label;
      status.className = "pill " + (TONES.indexOf(run.status_tone) >= 0 ? run.status_tone : "neutral");
    }
    each(root, "[data-run-count]", function (el) {
      var value = run[el.getAttribute("data-run-count")];
      if (typeof value === "number") el.textContent = numbers.format(value);
    });
    var cost = root.querySelector("[data-run-cost]");
    if (cost && run.cost && typeof run.cost.text === "string") cost.textContent = run.cost.text;
  }

  /* Ход запуска в панели: этапы, счётчики, ошибка, ссылка на компании в конце. */
  function setupRunPolling() {
    var panel = document.getElementById("run-panel");
    var runId = panel && panel.getAttribute("data-run-id");
    if (!runId || !/^[0-9]+$/.test(runId) || panel.getAttribute("data-finished") === "true") return;
    var interval = parseInt(panel.getAttribute("data-poll-ms"), 10) || 2000;
    var note = panel.querySelector("[data-run-poll]");
    var historyRow = document.querySelector("tr[data-history-run='" + runId + "']");
    var targets = historyRow ? [panel, historyRow] : [panel];

    function showNote(text) {
      if (!note) return;
      note.textContent = text;
      note.hidden = !text;
    }

    function apply(run) {
      showNote("");
      targets.forEach(function (root) { applyCommon(root, run); });
      var byCode = {};
      (run.stages || []).forEach(function (stage) { byCode[stage.code] = stage; });
      each(panel, "[data-stage]", function (el) {
        var stage = byCode[el.getAttribute("data-stage")];
        if (!stage) return;
        el.setAttribute("data-state", stage.state);
        var label = el.querySelector("[data-stage-state]");
        if (label) label.textContent = stage.state_label;
        var hint = el.querySelector("[data-stage-hint]");
        if (hint && typeof stage.hint === "string") hint.textContent = stage.hint;
      });
      each(panel, "[data-stage-track]", function (el) {
        var stage = byCode[el.getAttribute("data-stage-track")];
        if (stage) el.setAttribute("data-state", stage.state);
      });
      var error = panel.querySelector("[data-run-error]");
      if (error) {
        error.textContent = run.error || "";
        error.hidden = !run.error;
      }
      var review = panel.querySelector("[data-run-review]");
      if (review) review.hidden = run.show_review !== true;
      updateBadge(run.pending_total);
    }

    pollRun(runId, interval, {
      onUpdate: apply,
      onFinish: function () {
        panel.setAttribute("data-finished", "true");
        var link = panel.querySelector("[data-run-link]");
        if (link) link.hidden = false;
        enableStart();
      },
      onGone: function () { showNote("Запуск не найден. Обновите страницу."); },
      onError: function () { showNote("Нет связи с сервером, пробую снова."); }
    });
  }

  /* Открыт старый запуск, а идёт другой: кнопка включится, когда тот закончится. */
  function setupActiveWatch() {
    var form = document.getElementById("search-form");
    var panel = document.getElementById("run-panel");
    var activeId = form && form.getAttribute("data-active-run-id");
    if (!activeId || !/^[0-9]+$/.test(activeId)) return;
    if (panel && panel.getAttribute("data-run-id") === activeId) return;
    var interval = (panel && parseInt(panel.getAttribute("data-poll-ms"), 10)) || 2000;
    pollRun(activeId, interval, { onUpdate: noop, onFinish: enableStart, onGone: enableStart, onError: noop });
  }

  /* «Скопировать»: тема и текст клиенту, без заметок для владельца. Кнопка видна, только если буфер доступен. */
  function setupCopy() {
    each(document, "[data-copy-letter]", function (button) {
      var pane = button.closest("article, section");
      var subject = pane && pane.querySelector("[data-letter-subject]");
      var body = pane && pane.querySelector("[data-letter-body]");
      if (!subject || !body || !navigator.clipboard || !window.isSecureContext) return;
      var status = pane.querySelector("[data-copy-status]");
      var original = status ? status.textContent : "";
      var timer = null;

      var label = button.textContent;

      /* Ответ виден и в строке рядом, и на самой кнопке: на телефоне строки нет. */
      function say(message, short) {
        if (status) status.textContent = message;
        button.textContent = short;
        window.clearTimeout(timer);
        timer = window.setTimeout(function () {
          if (status) status.textContent = original;
          button.textContent = label;
        }, 3000);
      }

      button.hidden = false;
      button.addEventListener("click", function () {
        var lines = Array.prototype.map.call(body.querySelectorAll(".line"), function (line) {
          return line.textContent;
        });
        var text = subject.textContent.trim() + "\n\n" + lines.join("\n");
        navigator.clipboard.writeText(text).then(
          function () { say("Тема и текст скопированы.", "Скопировано"); },
          function () { say("Не удалось скопировать: выделите текст вручную.", "Не вышло"); }
        );
      });
    });
  }

  /* Фильтры списка применяются сразу при выборе. */
  function setupAutosubmit() {
    each(document, "select[data-autosubmit]", function (select) {
      select.addEventListener("change", function () {
        if (select.form && typeof select.form.requestSubmit === "function") select.form.requestSubmit();
        else if (select.form) select.form.submit();
      });
    });
  }

  /* Отклонение письма спрашивает подтверждение. */
  function setupConfirm() {
    each(document, "form[data-confirm]", function (form) {
      form.addEventListener("submit", function (event) {
        if (!window.confirm(form.getAttribute("data-confirm"))) event.preventDefault();
      });
    });
  }

  onReady(function () {
    setupSearchForm();
    setupSearchSubmit();
    setupRunPolling();
    setupActiveWatch();
    setupAutosubmit();
    setupConfirm();
    setupCopy();
  });
})();
