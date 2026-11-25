'use client'

import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { MarkdownEditor } from './MarkdownEditor'

type Level = {
  id: number
  name: string
  color: string
  ink: string
  archived: boolean
}

type Step = {
  id: string
  title: string
  body: string
  level: number
  image: string | null
  rendered?: string
}

type WorkspaceProps = {
  levels: Level[]
  draft: {title: string; steps: Step[]}
  selected: string | null
  dirty: boolean
  published: boolean
  preview: (level: number) => Promise<Step[]>
  changeLevel: (id: string, level: number) => void
  changeBody: (id: string, body: string) => void
  readBody: (body: string) => Promise<string>
}

const formats = [['B','bold','Жирный'], ['I','italic','Курсив'], ['H₂','heading','Заголовок'],
  ['•','list','Список'], ['1.','ordered','Нумерованный список'], ['↗','link','Ссылка'], ['<>','code','Код']]
function Icon({
  name,
  className = 'h-5 w-5',
}: {
  name: 'book' | 'chevron' | 'eye' | 'plus' | 'grip' | 'image' | 'table' | 'settings' | 'check' | 'more'
  className?: string
}) {
  const paths = {
    book: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M20 5.5A2.5 2.5 0 0 0 17.5 3H13v15h4.5a2.5 2.5 0 0 1 2.5 2.5z"/></>,
    chevron: <path d="m9 18 6-6-6-6"/>,
    eye: <><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/></>,
    plus: <path d="M12 5v14M5 12h14"/>,
    grip: <><circle cx="9" cy="7" r=".8" fill="currentColor"/><circle cx="15" cy="7" r=".8" fill="currentColor"/><circle cx="9" cy="12" r=".8" fill="currentColor"/><circle cx="15" cy="12" r=".8" fill="currentColor"/><circle cx="9" cy="17" r=".8" fill="currentColor"/><circle cx="15" cy="17" r=".8" fill="currentColor"/></>,
    image: <><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="9" r="1.5"/><path d="m4 17 5-5 4 4 2-2 5 5"/></>,
    table: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 4v16"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    more: <><circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="19" cy="12" r="1" fill="currentColor"/></>,
  }
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>{paths[name]}</svg>
}

export function EditorWorkspace({levels, draft, selected, dirty, published, preview, changeLevel, changeBody, readBody}: WorkspaceProps) {
  const [steps, setSteps] = useState(draft.steps)
  const [title, setTitle] = useState(draft.title)
  const selectable = levels.filter(level => !level.archived)
  const selectedStep = Math.max(0, steps.findIndex(step => step.id === selected))
  const step = steps[selectedStep]
  const [previewLevel, setPreviewLevel] = useState(selectable[0]?.id)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [visibleSteps, setVisibleSteps] = useState<Step[]>([])
  const [previewError, setPreviewError] = useState('')
  const [previewLoading, setPreviewLoading] = useState(false)
  const activePreview = selectable.find(level => level.id === previewLevel)
  useEffect(() => {
    if (!previewOpen || previewLevel == null) return
    let active = true
    setVisibleSteps([])
    setPreviewError('')
    setPreviewLoading(true)
    preview(previewLevel).then(items => {
      if (active) setVisibleSteps(items)
    }).catch(error => {
      if (active) setPreviewError(error.message)
    }).finally(() => { if (active) setPreviewLoading(false) })
    return () => { active = false }
  }, [previewOpen, previewLevel, preview])
  const changeStep = (field: 'title' | 'body', value: string) => {
    setSteps(items => items.map(item => item.id === step.id ? {...item, [field]: value} : item))
  }

  return (
    <div className="min-h-screen bg-[#f4f1e9] text-[#24231f]">
      <header className="flex min-h-16 flex-wrap items-center justify-between gap-x-3 border-b border-black/10 bg-[#fffdf8] px-5 lg:px-8">
        <div className="flex items-center gap-3">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-[#f05a39] text-white shadow-[0_3px_0_#b83f26]">
            <Icon name="book" className="h-5 w-5" />
          </div>
          <div>
            <p className="font-display text-[17px] font-bold leading-none">Моделкин</p>
            <p className="mt-1 text-[11px] text-black/45">мастерская инструкций</p>
          </div>
        </div>
        <div className="order-last flex w-full items-center gap-2 pb-2 text-sm text-black/45 md:order-none md:w-auto md:pb-0">
          <button data-action="library">Мои инструкции</button><Icon name="chevron" className="h-4 w-4" />
          <span className="max-w-64 truncate font-medium text-black/75">{title}</span>
        </div>
        <div className="flex items-center gap-3">
          <div className="hidden text-right sm:block">
            <p className="text-xs font-semibold">Администратор</p>

          </div>
          <div className="grid h-9 w-9 place-items-center rounded-full bg-[#203b36] text-xs font-bold text-white" aria-hidden>А</div>
          <button className="text-xs font-semibold" data-action="logout">Выйти</button>
        </div>
      </header>

      <section className="border-b border-black/10 bg-[#fffdf8] px-5 py-5 lg:px-8">
        <div className="mx-auto flex max-w-[1440px] flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <div>
            <div className="mb-2 flex items-center gap-2 text-xs text-black/45">
              <span className="rounded-full bg-[#f1ede2] px-2.5 py-1 font-medium">{published ? "Опубликована" : "Черновик"}</span>
              <span id="draft-status" role="status">{dirty ? "Есть несохранённые изменения" : "Черновик сохранён"}</span>
            </div>
            <input id="draft-title" aria-label="Название инструкции" maxLength={150} value={title} onChange={event => setTitle(event.target.value)} className="w-full rounded-md bg-transparent font-display text-2xl font-bold tracking-[-0.02em] lg:text-[30px]" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => setPreviewOpen(true)} disabled={!steps.length} className="flex h-10 items-center gap-2 rounded-xl border border-black/15 bg-white px-4 text-sm font-semibold shadow-sm transition hover:-translate-y-0.5">
              <Icon name="eye" className="h-4 w-4" /> Предпросмотр
            </button>
            <button data-action="publication" disabled={!steps.length} className="h-10 rounded-xl bg-[#f05a39] px-5 text-sm font-bold text-white shadow-[0_3px_0_#b83f26] transition hover:-translate-y-0.5 active:translate-y-0 active:shadow-none">
              Опубликовать
            </button>
            <button data-action="save" disabled={!dirty} className="grid h-10 w-10 place-items-center rounded-xl border border-black/15 bg-white" aria-label="Сохранить черновик" title="Сохранить черновик"><Icon name="check" className="h-5 w-5" /></button>
          </div>
        </div>
      </section>

      <div className="mx-auto grid max-w-[1504px] grid-cols-1 gap-0 lg:grid-cols-[300px_minmax(0,1fr)_280px]">
        <aside className="border-r border-black/10 bg-[#faf8f2] p-4 lg:min-h-[calc(100vh-153px)]">
          <div className="mb-3 flex items-center justify-between px-1">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-black/45">Шаги · {steps.length}</p>
            <button data-action="step-add" disabled={steps.length >= 250} className="grid h-8 w-8 place-items-center rounded-lg bg-[#e6f3ee] text-[#19795b]" aria-label="Добавить шаг"><Icon name="plus" className="h-4 w-4" /></button>
          </div>
          <div className="space-y-2">
            {steps.map((item, index) => (
              <button key={item.id} data-step={item.id} data-action="select-step" aria-current={selectedStep === index ? "step" : undefined} className={`group flex w-full items-start gap-2 rounded-xl border p-3 text-left transition ${selectedStep === index ? 'border-[#f05a39]/40 bg-white shadow-[0_4px_14px_rgba(56,47,32,.08)]' : 'border-transparent hover:bg-white/70'}`}>
                <span className="handle" draggable aria-label="Перетащить шаг"><Icon name="grip" className="mt-0.5 h-5 w-5 shrink-0 text-black/25" /></span>
                <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11px] font-bold ${selectedStep === index ? 'bg-[#f05a39] text-white' : 'bg-[#e9e5da] text-black/55'}`}>{index + 1}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{item.title}</span>
                  <span className="mt-1 flex items-center gap-1.5 text-[10px] font-medium text-black/65">
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: levels.find(level => level.id === item.level)?.color }} /> {levels.find(level => level.id === item.level)?.name}
                  </span>
                </span>
              </button>
            ))}
          </div>
          <button data-action="step-add" disabled={steps.length >= 250} className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-black/20 py-3 text-xs font-semibold text-black/50 hover:border-[#f05a39]/50 hover:text-[#f05a39]">
            <Icon name="plus" className="h-4 w-4" /> Добавить шаг
          </button>
        </aside>

        <section className="min-w-0 bg-[#f4f1e9] px-5 py-6 lg:px-8">
          <div className="mx-auto max-w-3xl" data-step={step?.id}>
            {step ? <>
            <div className="mb-5 flex items-center justify-between">
              <div>
                <p className="text-xs font-semibold text-[#f05a39]">ШАГ {selectedStep + 1}</p>
                <h2 className="font-display mt-1 text-xl font-bold">Редактирование шага</h2>
              </div>
              <div className="flex gap-1">
                <button data-action="step-up" aria-label="Переместить шаг выше" className="grid h-9 w-9 -rotate-90 place-items-center rounded-lg border border-black/10 bg-white disabled:opacity-30" disabled={selectedStep === 0}><Icon name="chevron" className="h-4 w-4" /></button>
                <button data-action="step-down" aria-label="Переместить шаг ниже" className="grid h-9 w-9 rotate-90 place-items-center rounded-lg border border-black/10 bg-white disabled:opacity-30" disabled={selectedStep === steps.length - 1}><Icon name="chevron" className="h-4 w-4" /></button>
              </div>
            </div>
            <div className="rounded-2xl border border-black/10 bg-[#fffdf9] p-5 shadow-[0_8px_30px_rgba(59,47,25,.06)] sm:p-7">
              <label htmlFor="figma-step-title" className="mb-2 block text-xs font-bold text-black/55">Заголовок шага</label>
              <input id="figma-step-title" data-field="title" maxLength={150} defaultValue={step.title} onInput={event => changeStep("title",event.currentTarget.value)} className="w-full rounded-xl border border-black/15 bg-white px-4 py-3 font-display text-lg font-bold outline-none focus:border-[#f05a39]" />
              <div className="mt-6 flex items-center justify-between">
                <span id="step-body-label" className="block text-xs font-bold text-black/55">Текст инструкции</span>
                <span className="text-[10px] font-medium text-black/35">Markdown</span>
              </div>
              <div className="mt-2 overflow-hidden rounded-xl border border-black/15 bg-white">
                <div className="step-format-bar flex flex-wrap items-center gap-1 border-b border-black/10 bg-[#f8f6f0] px-2 py-2">
                  {formats.map(([tool, action, label]) => <button key={tool} data-action={`format-${action}`} aria-label={label} className="h-7 min-w-7 rounded-md px-1.5 text-xs font-semibold text-black/55 hover:bg-white">{tool}</button>)}
                  <span className="mx-1 h-5 w-px bg-black/10" />
                  <button data-action="choose-image" className="flex h-7 items-center gap-1 rounded-md px-2 text-xs font-semibold text-black/55 hover:bg-white"><Icon name="image" className="h-4 w-4" /> Фото</button>
                  <button data-action="table" className="flex h-7 items-center gap-1 rounded-md px-2 text-xs font-semibold text-black/55 hover:bg-white"><Icon name="table" className="h-4 w-4" /> Таблица</button>
                </div>
                <input type="file" hidden data-field="image" accept="image/jpeg,image/png,image/webp,image/gif" />
                <MarkdownEditor key={step.id} initialValue={step.body} readBody={readBody} onChange={value => changeBody(step.id, value)} />
              </div>
              {step.image && <div className="legacy-image mt-4">
                <img className="preview-image" src={`/image/${step.image}`} alt="Иллюстрация к шагу" />
                <button data-action="move-image">Перенести к курсору</button>
                <button data-action="image-remove">Убрать фото</button>
              </div>}
              <div className="mt-6">
                <label className="mb-2 block text-xs font-bold text-black/55">Минимальный уровень</label>
                <div className="flex flex-wrap gap-2">
                  {levels.filter(level => !level.archived || level.id === step.level).map(level => (
                    <button key={level.id} disabled={level.archived} aria-pressed={step.level === level.id} onClick={() => changeLevel(step.id,level.id)} className={`flex items-center gap-2 rounded-full border px-3 py-2 text-xs font-semibold ${step.level === level.id ? 'ring-2 ring-current ring-offset-2 shadow-sm' : 'border-transparent'}`} style={{ color: level.ink, backgroundColor: level.color }}>
                      <span className="h-2.5 w-2.5 rounded-full bg-current" />{level.name}{step.level === level.id && <Icon name="check" className="h-3.5 w-3.5" />}
                    </button>
                  ))}
                </div>
                <p className="mt-2 text-[11px] text-black/40">Шаг увидят читатели этого и более сложных уровней.</p>
              </div>
              <button className="mt-4 text-xs text-[#973420]" data-action="step-remove">Удалить шаг</button>
            </div>
            </> : <p className="rounded-2xl border border-black/10 bg-[#fffdf9] p-5">Добавьте первый шаг.</p>}
          </div>
        </section>

        <aside className="border-l border-black/10 bg-[#faf8f2] p-5">
          <div className="mb-5 flex items-center justify-between">
            <h3 className="font-display font-bold">Уровни сложности</h3>
            <button className="grid h-8 w-8 place-items-center rounded-lg border border-black/10 bg-white" data-action="levels" aria-label="Настроить уровни"><Icon name="settings" className="h-4 w-4" /></button>
          </div>
          <div className="space-y-3">
            {selectable.map((level, index) => (
              <div key={level.id} className="rounded-xl border border-black/10 bg-white p-3">
                <div className="flex items-center gap-2">
                  <span className="h-3 w-3 rounded-full" style={{ backgroundColor: level.color }} />
                  <span className="flex-1 text-sm font-semibold">{level.name}</span>
                  <span className="text-[10px] text-black/35">{index + 1}</span>
                </div>
                <p className="mt-2 pl-6 text-[10px] text-black/40">{steps.filter((item) => item.level === level.id).length} шага напрямую</p>
              </div>
            ))}
          </div>
          <button data-action="levels" className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-black/20 py-3 text-xs font-semibold text-black/50">
            <Icon name="plus" className="h-4 w-4" /> Добавить уровень
          </button>
          <div className="mt-7 rounded-xl bg-[#e9eee8] p-4">
            <p className="text-xs font-bold text-[#203b36]">Постоянные ссылки</p>
            <p className="mt-1 text-[11px] leading-5 text-[#203b36]/60">После публикации у каждого уровня появится своя ссылка. Обновления откроются по ней же.</p>
          </div>
        </aside>
      </div>

      {previewOpen && (
        <div onClick={event => { if (event.target === event.currentTarget) setPreviewOpen(false) }} className="fixed inset-0 z-40 overflow-y-auto bg-[#1a2422]/70 p-4 backdrop-blur-sm sm:p-8">
          <div className="mx-auto min-h-full max-w-4xl overflow-hidden rounded-[24px] bg-[#fffdf8] shadow-2xl">
            <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 border-b border-black/10 bg-[#fffdf8]/95 px-5 py-4 backdrop-blur">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-black/40">Предпросмотр читателя</p>
                <p className="font-display font-bold">{title}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {selectable.map(level => <button key={level.id} aria-pressed={previewLevel === level.id} onClick={() => setPreviewLevel(level.id)} className={`rounded-full px-3 py-2 text-xs font-semibold ${previewLevel === level.id ? 'ring-2 ring-current ring-offset-2' : ''}`} style={{ color: level.ink, backgroundColor: level.color }}>{level.name}</button>)}
                <button onClick={() => setPreviewOpen(false)} className="ml-2 rounded-xl border border-black/15 px-4 py-2 text-xs font-bold">Закрыть</button>
              </div>
            </div>
            <div className="mx-auto max-w-2xl px-6 py-12">
              <div className="mb-10">
                <span className="rounded-full px-3 py-1.5 text-xs font-bold" style={{ color: activePreview?.ink, backgroundColor: activePreview?.color }}>{activePreview?.name}</span>
                <h2 className="font-display mt-4 text-4xl font-bold tracking-[-.03em]">{title}</h2>
                <p className="mt-3 text-sm leading-7 text-black/55">Вам доступны {visibleSteps.length} из {steps.length} шагов — только нужная сложность, без лишних деталей.</p>
              </div>
              {previewError && <p role="alert">{previewError}</p>}
              {previewLoading && <p role="status">Загрузка…</p>}
              {!previewError && !previewLoading && !visibleSteps.length && <p>Для этого уровня пока нет шагов.</p>}
              <div className="space-y-5">
                {visibleSteps.map((item, index) => (
                  <article key={`${item.title}-${index}`} className="rounded-2xl border border-black/10 bg-white p-6 shadow-[0_6px_22px_rgba(48,38,20,.05)]">
                    <div className="flex gap-4">
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[#f05a39] font-display text-sm font-bold text-white">{index + 1}</span>
                      <div className="step-preview-content min-w-0 flex-1"><h3 className="font-display text-xl font-bold">{item.title}</h3>{item.image && <img src={`/image/${item.image}`} alt="Иллюстрация к шагу" />}
                      <div className="markdown mt-2 text-sm leading-7 text-black/60" dangerouslySetInnerHTML={{__html: item.rendered || ""}} /></div>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

let mounted: ReturnType<typeof createRoot> | undefined
Object.assign(window, {
  mountFigmaEditor(container: HTMLElement, props: WorkspaceProps) {
    mounted = createRoot(container)
    flushSync(() => mounted?.render(<EditorWorkspace {...props} />))
  },
  unmountFigmaEditor() {
    mounted?.unmount()
    mounted = undefined
  },
})
