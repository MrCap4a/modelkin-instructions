"use strict";

const app = document.querySelector("#app");
const logout = document.querySelector("#logout");
const notice = document.querySelector("#notice");
const state = { drafts: [], levels: [], current: null, dirty: false, panel: "library", releases: [], search: "", filter: "all", selected: null, levelEdit: null, dragged: null };
let noticeTimer;

const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const button = (label, action, css = "quiet", disabled = false) =>
  `<button type="button" class="${css}" data-action="${action}" ${disabled ? "disabled" : ""}>${label}</button>`;
const activeLevels = () => state.levels.filter(level => !level.archived);

async function api(path, method = "GET", payload) {
  const isFile = payload instanceof FormData;
  const headers = { "X-Modelkin-Request": "1" };
  if (payload && !isFile) headers["Content-Type"] = "application/json";
  const response = await fetch("/api" + path, {
    method, headers, body: isFile ? payload : payload && JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || (response.status === 413 ? "Превышен допустимый размер запроса." : "Не удалось выполнить запрос."));
    error.status = response.status;
    throw error;
  }
  return data;
}

function notify(message, error = false) {
  clearTimeout(noticeTimer);
  notice.textContent = message;
  notice.dataset.error = error;
  notice.hidden = false;
  noticeTimer = setTimeout(() => { notice.hidden = true; }, error ? 9000 : 2800);
}

async function run(action) {
  if (app.inert) return;
  app.inert = true;
  try {
    await action();
  } catch (error) {
    notify(error.message, true);
  } finally {
    app.inert = false;
  }
}

async function refresh() {
  Object.assign(state, await api("/state"));
}

function loginView() {
  document.querySelector("#admin-nav").hidden = true;
  logout.hidden = true;
  document.querySelector("#account-label").hidden = true;
  app.className = "login";
  app.innerHTML = `<form class="card stack" id="login">
    <h1>Вход в админку</h1>
    <label>Логин<input name="login" autocomplete="username" required autofocus></label>
    <label>Пароль<input name="password" type="password" autocomplete="current-password" required></label>
    <button class="primary">Войти</button>
  </form>`;
}

const palette = [
  ["Мятный", "#30b383"], ["Янтарный", "#e3a319"], ["Коралловый", "#e46142"],
  ["Шалфейный", "#92bc89"], ["Бирюзовый", "#48a9ac"], ["Хвойный", "#247c69"],
  ["Пшеничный", "#efc773"], ["Абрикосовый", "#ed9b64"], ["Охра", "#b47e32"],
  ["Розовый", "#d87e8d"], ["Вересковый", "#ae85af"], ["Терракотовый", "#b35340"]
];

function tagStyle(color) {
  const rgb = color.match(/[a-f0-9]{2}/gi).map(hex => {
    const channel = parseInt(hex, 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const luminance = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  return `--tag:${color};--tag-ink:${luminance > 0.179 ? "#000000" : "#ffffff"}`;
}

function tag(level) {
  return `<span class="tag" style="${tagStyle(level.color)}">${escapeHtml(level.name)}</span>`;
}

function levelsView() {
  const active = activeLevels();
  const archived = state.levels.filter(level => level.archived);
  const selected = active.find(level => level.id === state.levelEdit);
  const colors = selected && !palette.some(([,color]) => color.toLowerCase() === selected.color.toLowerCase()) ?
    [...palette, ["Текущий цвет", selected.color]] : palette;
  return `<section class="levels-screen">
    <header class="page-heading"><h1>Уровни сложности</h1>${button("Добавить уровень", "level-create", "primary")}</header>
    <p class="muted">От простого к сложному. Читатель видит свой уровень и все предыдущие.</p>
    <div class="levels-grid">
      <div class="stack">
        <section class="card"><h2>Активные уровни</h2>
          ${active.map((level,index) => `<div class="level-row ${selected === level ? "chosen" : ""}" data-level="${level.id}" data-sortable-level>
            <div class="level-name"><span class="level-handle" draggable="true" title="Перетащить уровень" aria-hidden="true">⠿</span>${tag(level)}</div>
            <div class="controls">${button("Выше","level-up","quiet",index===0)}
            ${button("Ниже","level-down","quiet",index===active.length-1)}
            ${button("Настроить","level-select")}</div>
          </div>`).join("")}
        </section>
        <section class="card"><h2>Архивные уровни</h2>
          ${archived.map(tag).join(" ") || '<p class="muted">В архиве пока ничего нет.</p>'}
        </section>
      </div>
      <section class="card level-form" ${selected ? `data-level="${selected.id}"` : ""}>
        <h2>${selected ? "Настроить уровень" : "Добавить уровень"}</h2>
        <form class="new-level" id="new-level">
          <label>Название<input name="name" required maxlength="60" value="${escapeHtml(selected?.name)}"></label>
          <fieldset class="palette"><legend>Цвет из палитры</legend><div class="swatches">
            ${colors.map(([name,color],index) => `<label class="swatch" title="${name}">
              <input type="radio" name="color" value="${color}" aria-label="${name}" ${(selected ? selected.color.toLowerCase()===color.toLowerCase() : index===0) ? "checked" : ""}>
              <span class="color-dot" style="${tagStyle(color)}"></span>
            </label>`).join("")}
          </div></fieldset>
          <button class="primary">${selected ? "Сохранить изменения" : "Добавить"}</button>
        </form>
        ${selected ? `<hr>${button("Архивировать уровень","level-archive","quiet danger",active.length===1)}
           <p class="muted">Уровень останется у уже назначенных шагов.</p>` : ""}
      </section>
    </div>
  </section>`;
}

function options(selected, allowArchived = false) {
  return state.levels.filter(level => !level.archived || (allowArchived && level.id === selected)).map(level =>
    `<option value="${level.id}" ${level.id === selected ? "selected" : ""}>${escapeHtml(level.name)}${level.archived ? " (в архиве)" : ""}</option>`
  ).join("");
}

function libraryItems() {
  const query = state.search.trim().toLocaleLowerCase("ru");
  const drafts = state.drafts.filter(draft => draft.title.toLocaleLowerCase("ru").includes(query) &&
    (state.filter === "all" || draft.published === (state.filter === "published")));
  return drafts.map(draft => `<li><button type="button" class="library-entry" data-action="draft-${draft.id}">
    
    <span class="entry-name"><strong>${escapeHtml(draft.title)}</strong><span class="muted">Шагов: ${draft.steps}</span></span>
    <span class="status-pill ${draft.published ? "is-published" : ""}">${draft.published ? "Опубликована" : "Черновик"}</span>
    <span class="entry-open">Открыть</span>
  </button><button class="delete-instruction quiet danger" data-action="delete-instruction" data-id="${draft.id}" aria-label="Удалить инструкцию «${escapeHtml(draft.title)}»">Удалить</button></li>`).join("") || `<li class="card muted">${query ? "По этому запросу ничего не найдено." : "Создайте первую инструкцию."}</li>`;
}

function libraryView() {
  return `<section class="library">
    <header class="page-heading"><h1>Мои инструкции</h1>${button("Создать инструкцию", "new", "primary")}</header>
    <div class="library-tools">
      <div class="controls" aria-label="Фильтр инструкций">
        ${[["all","Все"],["draft","Черновики"],["published","Опубликованные"]].map(([id,label]) =>
          button(label,"filter-"+id,"quiet "+(state.filter===id?"chosen":""))).join("")}
      </div>
      <label class="search-label"><input type="search" aria-label="Поиск по названию" id="library-search" value="${escapeHtml(state.search)}" placeholder="Поиск по названию…"></label>
    </div>
    <ul class="library-list" id="library-list">${libraryItems()}</ul>
  </section>`;
}

function publicationView() {
  const latest = state.releases[0];
  return `<section class="publication-screen">
    ${button("В редактор", "editor", "back-link")}
    <h1>Публикация и версии</h1>
    <div class="publish-banner">
      <div><h2>Версия ${(latest?.number || 0) + 1}</h2><p class="muted">${latest ?
        `Сейчас читатели видят версию ${latest.number}. После публикации ссылки откроют новую версию.` :
        "После публикации появятся постоянные ссылки по уровням сложности."}</p></div>
      <div class="controls">
        ${button("Предпросмотр", "preview", "quiet", !state.current.steps.length)}
        ${button("Опубликовать", "publish-review", "primary", !state.current.steps.length)}
      </div>
    </div>
    <div class="publication-grid">
      <section class="card"><h2>Ссылки для читателей</h2><p class="muted">Открываются без входа</p>
      ${latest?.links.map(link => `<div class="link-row">
        <div>${tag(link)}<div class="muted">Шагов: ${link.steps}</div></div>
        <div class="controls"><button class="quiet" data-copy="${link.path}">Копировать</button>
        <a class="button quiet" href="${link.path}" target="_blank" rel="noopener">Открыть</a></div>
      </div>`).join("") || '<p class="muted">Ссылки появятся после первой публикации.</p>'}
      </section>
      <aside class="publication-note"><h2>Одна ссылка.<br>Новая версия.</h2><p>При обновлении инструкции ссылки остаются прежними. Старые версии доступны в истории публикаций.</p></aside>
    </div>
    <section class="card history"><h2>История публикаций</h2>
      ${state.releases.map((release,index) => `<details class="history-version">
        <summary>Версия ${release.number} <span class="muted">${index ? "В архиве" : "Текущая публикация"}</span></summary>
        <div class="controls">${release.links.map(link => `<a class="button quiet" href="${link.archive}" target="_blank" rel="noopener">${escapeHtml(link.name)}</a>`).join("")}</div>
      </details>`).join("") || '<p class="muted">Версий пока нет.</p>'}
    </section>
  </section>`;
}

function renderEditor() {
  app.innerHTML = '<div id="figma-editor"></div>';
  window.mountFigmaEditor(app.firstElementChild, {
    draft: state.current,
    levels: state.levels.map(level => ({
      ...level,
      ink: tagStyle(level.color).endsWith("#ffffff") ? "#fff" : "#000"
    })),
    selected: state.selected,
    dirty: state.dirty,
    published: state.releases.length > 0,
    preview: async level => (await api(`/drafts/${state.current.id}/preview`, "POST",
      { steps: state.current.steps, level })).steps,
    changeLevel: (id, level) => {
      state.current.steps.find(step => step.id === id).level = level;
      dirty();
      render();
      requestAnimationFrame(() => app.querySelector('[aria-pressed="true"]')?.focus());
    },
    readBody: body => api("/markdown", "POST", { body }),
    changeBody: (id, body) => {
      state.current.steps.find(step => step.id === id).body = body;
      dirty();
    }
  });
}

function render() {
  window.unmountFigmaEditor();
  logout.hidden = false;
  document.querySelector("#account-label").hidden = false;
  const nav = document.querySelector("#admin-nav");
  nav.hidden = false;
  nav.innerHTML = `${button("Мои инструкции", "library", "nav-button" + (state.panel !== "levels" ? " current" : ""))}
    ${button("Уровни сложности", "levels", "nav-button" + (state.panel === "levels" ? " current" : ""))}`;
  app.className = "layout";
  if (state.panel === "draft") renderEditor();
  else app.innerHTML = state.panel === "levels" ? levelsView() : state.panel === "publication" ? publicationView() : libraryView();
}

function dirty() {
  state.dirty = true;
  const status = document.querySelector("#draft-status");
  if (status) status.textContent = "Есть несохранённые изменения";
  const save = app.querySelector('[data-action="save"]');
  if (save) save.disabled = false;
}

function canLeave() {
  return !state.dirty || confirm("Перейти без сохранения изменений?");
}

function sourceStep(element) {
  const key = element.closest("[data-step]")?.dataset.step;
  return state.current?.steps.find(step => step.id === key);
}

function moveStep(step, index) {
  const steps = state.current.steps;
  steps.splice(steps.indexOf(step), 1);
  steps.splice(index, 0, step);
  dirty();
  render();
}

function dialog(title, contents) {
  const element = document.createElement("dialog");
  element.innerHTML = `<header class="step-head"><h2>${title}</h2><form method="dialog"><button class="quiet">Закрыть</button></form></header>${contents}`;
  document.body.append(element);
  element.addEventListener("close", () => element.remove());
  element.showModal();
  return element;
}

async function showPreview(level = activeLevels()[0].id) {
  const element = dialog("Предпросмотр", `<label>Уровень<select>${options(level)}</select></label><div class="stack" data-preview></div>`);
  const select = element.querySelector("select");
  const content = element.querySelector("[data-preview]");
  let requestNumber = 0;
  const preview = async () => {
    const number = ++requestNumber;
    content.textContent = "Загрузка…";
    try {
      const data = await api(`/drafts/${state.current.id}/preview`, "POST",
        { steps: state.current.steps, level: Number(select.value) });
      if (number !== requestNumber) return;
      content.innerHTML = data.steps.map((step, index) => `<article class="card">
        <p class="muted">Шаг ${index + 1} из ${data.steps.length}</p>
        ${step.title ? `<h3>${escapeHtml(step.title)}</h3>` : ""}
        ${step.image ? `<img class="preview-image" src="/image/${escapeHtml(step.image)}" alt="Иллюстрация к шагу">` : ""}
        <div class="markdown">${step.rendered}</div>
      </article>`).join("") || "Для этого уровня пока нет шагов.";
    } catch (error) {
      if (number === requestNumber) content.textContent = error.message;
    }
  };
  select.addEventListener("change", preview);
  await preview();
}

async function copyLink(control) {
  const url = new URL(control.dataset.copy, location.href).href;
  try {
    await navigator.clipboard.writeText(url);
    control.textContent = "Скопировано";
  } catch {
    prompt("Скопируйте ссылку", url);
  }
}

app.addEventListener("submit", event => {
  event.preventDefault();
  const form = event.target;
  const fields = Object.fromEntries(new FormData(form));
  run(async () => {
    if (form.id === "login") {
      await api("/login", "POST", fields);
      await refresh();
      render();
    } else if (form.id === "new-level") {
      const id = state.levelEdit;
      Object.assign(state, await api(id ? "/levels/" + id : "/levels", id ? "PUT" : "POST", fields));
      render();
    }
  });
});

app.addEventListener("input", event => {
  const field = event.target;
  if (field.id === "library-search") {
    state.search = field.value;
    app.querySelector("#library-list").innerHTML = libraryItems();
    return;
  }
  if (field.id === "draft-title") {
    state.current.title = field.value;
    dirty();
  }
  const step = sourceStep(field);
  if (step && ["title", "body", "level"].includes(field.dataset.field)) {
    step[field.dataset.field] = field.dataset.field === "level" ? Number(field.value) : field.value;
    if (field.dataset.field === "level") {
      const restore = Number(field.value);
      render();
      requestAnimationFrame(() => app.querySelector(`input[data-field="level"][value="${restore}"]`)?.focus());
    }
    dirty();
  }
});

app.addEventListener("change", event => {
  const field = event.target;
  if (field.dataset.field !== "image" || !field.files.length) return;
  const files = [...field.files];
  field.value = "";
  uploadStepImages(stepEditor(field), files);
});

function uploadStepImages(editor, files) {
  run(async () => {
    for (const file of files) {
      const data = new FormData();
      data.append("image", file);
      const id = (await api("/images", "POST", data)).id;
      if (!insertBlock(editor, `![Описание изображения](/image/${id})`)) break;
    }
    requestAnimationFrame(() => editor.focus());
  });
}

function insertTransferredImages(event) {
  const host = event.target.closest(".step-markdown");
  const transfer = event.clipboardData || event.dataTransfer;
  if (!host || !transfer) return;
  const files = [...transfer.files].filter(file => file.type.startsWith("image/"));
  if (!files.length) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.type === "drop") host.stepEditor.moveToPoint(event.clientX, event.clientY);
  uploadStepImages(host.stepEditor, files);
}
app.addEventListener("paste", insertTransferredImages, true);
app.addEventListener("drop", insertTransferredImages, true);
app.addEventListener("dragover", event => {
  if (event.target.closest(".step-markdown") && event.dataTransfer.types.includes("Files")) event.preventDefault();
}, true);

const markdownFormats = {
  bold: ["**", "**", "жирный текст"],
  italic: ["*", "*", "курсив"],
  heading: ["## ", "", "Заголовок", true],
  list: ["- ", "", "Пункт списка", true],
  ordered: ["1. ", "", "Пункт списка", true],
  link: ["[", "](https://)", "Текст ссылки"],
  quote: ["> ", "", "Цитата", true],
  code: ["`", "`", "код"]
};

function stepEditor(control) {
  return control.closest("[data-step]").querySelector(".step-markdown").stepEditor;
}

function formatMarkdown(control, format) {
  const field = stepEditor(control);
  if (format === "bold" || format === "italic") {
    field.toggleEmphasis(format === "bold");
    return;
  }
  const [prefix, suffix, placeholder, line] = markdownFormats[format];
  let { from: start, to: end } = field.selection;
  if (line && start > 0) start = field.value.lastIndexOf("\n", start - 1) + 1;
  const selected = field.value.slice(start, end);
  const text = (selected || placeholder).split("\n").join(line ? "\n" + prefix : "\n");
  const insertion = prefix + text + suffix;
  if (!field.replace(start, end, insertion, start + prefix.length, start + prefix.length + text.length))
    notify("В этом шаге достигнут предел длины текста.", true);
}

function insertBlock(field, markdown) {
  const { from: start } = field.selection;
  const before = field.value.slice(0, start);
  const after = field.value.slice(start);
  const prefix = before ? (before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n") : "";
  const suffix = after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";
  const insertion = prefix + markdown + suffix;
  if (!field.replace(start, start, insertion, start + insertion.length)) {
    notify("В этом шаге достигнут предел длины текста.", true);
    return false;
  }
  return true;
}

function tableDialog(field) {
  const modal = dialog("Вставить таблицу", `<form id="table-form" class="stack">
    <div class="table-dimensions">
      <label>Столбцы<input name="columns" type="number" min="1" max="8" value="3" required></label>
      <label>Строки без заголовка<input name="rows" type="number" min="1" max="20" value="2" required></label>
    </div>
    <div class="table-scroll" data-grid></div>
    <div><button class="primary">Вставить таблицу</button></div>
  </form>`);
  const form = modal.querySelector("#table-form");
  const grid = modal.querySelector("[data-grid]");
  const values = new Map();
  grid.addEventListener("input", event => values.set(event.target.name, event.target.value));
  const dimensions = () => [form.elements.columns.valueAsNumber, form.elements.rows.valueAsNumber];
  const keys = (rows, columns, callback) => Array.from({ length: rows }, (_, row) =>
    Array.from({ length: columns }, (_, col) => callback(row, col, `${row}-${col}`)));
  const draw = () => {
    if (!form.elements.columns.validity.valid || !form.elements.rows.validity.valid) return;
    const [columns, rows] = dimensions();
    grid.innerHTML = `<table class="table-grid"><tbody>${keys(rows + 1, columns, (row, col, key) => {
      const label = row ? `Строка ${row}, столбец ${col + 1}` : `Заголовок ${col + 1}`;
      return `<td><input name="${key}" aria-label="${label}" placeholder="${row ? "" : label}" value="${escapeHtml(values.get(key))}" maxlength="200"></td>`;
    }).map(row => "<tr>" + row.join("") + "</tr>").join("")}</tbody></table>`;
  };
  modal.querySelector(".table-dimensions").addEventListener("change", draw);
  draw();
  form.addEventListener("submit", event => {
    event.preventDefault();
    const [columns, rows] = dimensions();
    const cells = keys(rows + 1, columns, (row, col, key) =>
      (values.get(key)?.trim() || (row === 0 ? `Столбец ${col + 1}` : "")).replaceAll("|", "\\|"));
    cells.splice(1, 0, Array(columns).fill("---"));
    const markdown = cells.map(row => "| " + row.join(" | ") + " |").join("\n");
    modal.close();
    insertBlock(field, markdown);
  });
}

function confirmPublication() {
  if (!state.current.title.trim() || !state.current.steps.length ||
      state.current.steps.some(step => !(step.title.trim() || step.body.trim() || step.image))) {
    notify("Укажите название инструкции и заполните каждый шаг.", true);
    return;
  }
  const panel = dialog("Опубликовать инструкцию?", `<div class="stack">
    <p>Черновик сохранится, а читателям станет доступна новая версия. После публикации вы получите ссылки по уровням сложности.</p>
    <div><button class="primary" id="confirm-publish">Опубликовать и получить ссылки</button></div>
  </div>`);
  panel.querySelector("#confirm-publish").addEventListener("click", () => {
    panel.close();
    run(async () => {
      const result = await api(`/drafts/${state.current.id}/releases`, "POST", state.current);
      state.releases = result.releases;
      applySavedDraft(result.draft);
      notify("Версия опубликована. Ссылки готовы.");
    });
  });
}

function applySavedDraft(draft) {
  const keepEditor = state.panel === "draft" && state.current.title === draft.title &&
    state.current.steps.every((step, i) => step.title === draft.steps[i]?.title);
  state.current = draft;
  state.dirty = false;
  Object.assign(state.drafts.find(item => item.id === draft.id), {
    title: draft.title, steps: draft.steps.length, published: state.releases.length > 0
  });
  if (keepEditor) {
    app.querySelector("#draft-status").textContent = "Черновик сохранён";
    app.querySelector('[data-action="save"]').disabled = true;
  } else render();
}

document.addEventListener("click", event => {
  if (!event.target.closest("#app, #admin-nav")) return;
  const copy = event.target.closest("[data-copy]");
  if (copy) { void copyLink(copy); return; }
  const control = event.target.closest("[data-action]");
  if (!control) return;
  const action = control.dataset.action;
  const restoreCaret = action === "save" && document.activeElement.closest(".step-markdown");
  if (action.startsWith("format-")) {
    formatMarkdown(control, action.slice(7));
    return;
  }
  if (action === "choose-image" || action === "table" || action === "move-image") {
    const article = control.closest("[data-step]");
    const field = stepEditor(control);
    if (action === "choose-image") article.querySelector('[data-field="image"]').click();
    else if (action === "table") tableDialog(field);
    else {
      const step = sourceStep(control);
      if (insertBlock(field, `![Описание изображения](/image/${step.image})`)) {
        step.image = null;
        render();
      }
    }
    return;
  }
  run(async () => {
    const step = sourceStep(control);
    const key = state.current?.id;
    if (action === "logout") {
      await signOut();
    } else if (action === "levels" || action === "library") {
      if (state.current && !canLeave()) return;
      state.dirty = false;
      state.current = null;
      state.panel = action;
      render();
    } else if (action === "delete-instruction") {
      const id = Number(control.dataset.id);
      const item = state.drafts.find(draft => draft.id === id);
      const modal = dialog("Удалить инструкцию?", `<p>«${escapeHtml(item.title)}» будет удалена вместе со всеми версиями. Выданные ссылки перестанут открываться.</p>
        <div class="controls"><button class="quiet" data-cancel>Отмена</button><button class="delete-confirm" data-confirm>Удалить инструкцию</button></div>`);
      modal.querySelector("[data-cancel]").onclick = () => modal.close();
      modal.querySelector("[data-confirm]").onclick = () => {
        modal.close();
        run(async () => {
          await api("/drafts/" + id, "DELETE");
          state.drafts = state.drafts.filter(draft => draft.id !== id);
          render();
          notify("Инструкция удалена.");
        });
      };
    } else if (action.startsWith("filter-")) {
      state.filter = action.slice(7);
      render();
    } else if (action === "publication" || action === "editor") {
      state.panel = action === "publication" ? "publication" : "draft";
      render();
    } else if (action === "select-step") {
      state.selected = step.id;
      render();
    } else if (action === "new" || action.startsWith("draft-")) {
      const created = action === "new";
      const id = created ? (await api("/drafts", "POST")).id : action.slice(6);
      const { draft, releases } = await api("/drafts/" + id + "/releases");
      if (created) state.drafts.unshift({ id: draft.id, title: draft.title, steps: 0, published: false });
      state.current = draft;
      state.selected = null;
      state.releases = releases;
      state.dirty = false;
      state.panel = "draft";
      render();
      if (created) {
        const title = app.querySelector("#draft-title");
        requestAnimationFrame(() => { title.focus(); title.select(); });
      }
    } else if (action === "level-select" || action === "level-create") {
      state.levelEdit = action === "level-select" ? Number(control.closest("[data-level]").dataset.level) : null;
      render();
      requestAnimationFrame(() => app.querySelector('#new-level input[name="name"]')?.focus());
    } else if (action.startsWith("level-")) {
      if (action === "level-archive" && !confirm("Отправить уровень в архив?")) return;
      const id = control.closest("[data-level]").dataset.level;
      Object.assign(state, await api("/levels/" + id, "POST", { action: action.slice(6) }));
      if (action === "level-archive") state.levelEdit = null;
      render();
    } else if (action === "step-add") {
      const bytes = crypto.getRandomValues(new Uint8Array(18));
      const id = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
      state.selected = id;
      state.current.steps.push({ id, title: "", body: "", image: null, level: activeLevels()[0].id });
      dirty();
      render();
      requestAnimationFrame(() => app.querySelector("#figma-step-title")?.focus());
    } else if (action === "step-up" || action === "step-down") {
      moveStep(step, state.current.steps.indexOf(step) + (action === "step-up" ? -1 : 1));
    } else if (action === "step-remove" || action === "image-remove") {
      if (action === "step-remove" && !confirm("Удалить этот шаг из черновика?")) return;
      if (action === "step-remove") state.current.steps.splice(state.current.steps.indexOf(step), 1);
      else step.image = null;
      dirty();
      render();
    } else if (action === "preview" || action === "preview-step") {
      await showPreview(action === "preview-step" ? Number(app.querySelector("#preview-level").value) : undefined);
    } else if (action === "publish-review") {
      confirmPublication();
    } else if (action === "save") {
      applySavedDraft(await api(`/drafts/${key}`, "PUT", state.current));
      if (restoreCaret) requestAnimationFrame(() => app.querySelector(".step-markdown")?.stepEditor.focus());
      notify("Черновик сохранён.");
    }
  });
});

function dragTarget(element) {
  const selector = state.dragged?.kind === "level" ? "[data-sortable-level]" : "[data-step]";
  return element.closest(selector);
}

function clearDrag() {
  state.dragged = null;
  app.querySelector(".dragging")?.classList.remove("dragging");
  app.querySelector(".drop-target")?.classList.remove("drop-target");
}

app.addEventListener("dragstart", event => {
  const level = event.target.closest(".level-handle")?.closest("[data-sortable-level]");
  const step = event.target.closest(".handle")?.closest("[data-step]");
  const row = level || step;
  if (!row) return;
  state.dragged = { kind: level ? "level" : "step", row };
  event.dataTransfer.setData("text/plain", row.dataset.level || row.dataset.step);
  event.dataTransfer.effectAllowed = "move";
  row.classList.add("dragging");
});

app.addEventListener("dragover", event => {
  if (!state.dragged) return;
  const target = dragTarget(event.target);
  app.querySelector(".drop-target")?.classList.remove("drop-target");
  if (!target || target === state.dragged.row) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  target.classList.add("drop-target");
});

app.addEventListener("drop", event => {
  if (!state.dragged) return;
  event.preventDefault();
  const target = dragTarget(event.target);
  const { row, kind } = state.dragged;
  clearDrag();
  if (!target || target === row) return;
  if (kind === "step") {
    moveStep(sourceStep(row), state.current.steps.indexOf(sourceStep(target)));
  } else {
    run(async () => {
      Object.assign(state, await api("/levels/" + row.dataset.level, "POST",
        { action: "move", target: Number(target.dataset.level) }));
      render();
    });
  }
});
app.addEventListener("dragend", clearDrag);

async function signOut() {
  if (!canLeave()) return;
  await api("/logout", "POST");
  state.current = null;
  state.dirty = false;
  state.panel = "library";
  state.search = "";
  window.unmountFigmaEditor();
  loginView();
}

logout.addEventListener("click", () => run(signOut));

window.addEventListener("beforeunload", event => {
  if (state.dirty) event.preventDefault();
});

(async () => {
  try {
    await refresh();
    render();
  } catch (error) {
    loginView();
    if (error.status !== 401) notify(error.message, true);
  } finally {
    app.setAttribute("aria-busy", "false");
  }
})();
