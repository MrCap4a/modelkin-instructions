import { useLayoutEffect, useRef, useState } from 'react'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentMore, indentLess } from '@codemirror/commands'
import { defaultHighlightStyle, syntaxHighlighting, indentUnit, syntaxTree } from '@codemirror/language'
import { markdown } from '@codemirror/lang-markdown'
import { Table } from '@lezer/markdown'
import { livePreview } from './livePreview'

const limit = 50000

function controls(view: EditorView) {
  return {
    get value() { return view.state.doc.toString() },
    get selection() { return view.state.selection.main },
    focus() { view.focus() },
    moveToPoint(x: number, y: number) {
      const pos = view.posAtCoords({ x, y })
      if (pos !== null) view.dispatch({ selection: { anchor: pos } })
    },
    toggleEmphasis(bold: boolean) {
      const { from, to } = view.state.selection.main
      const nodeName = bold ? 'StrongEmphasis' : 'Emphasis'
      const tree = syntaxTree(view.state)
      const enclosingAt = (side: number) => {
        let node = tree.resolveInner(from, side)
        while (node.name !== nodeName && node.parent) node = node.parent
        return node.name === nodeName ? node : null
      }
      const enclosing = enclosingAt(1) ?? enclosingAt(-1)
      if (enclosing && enclosing.to >= to) {
        const [open, close] = enclosing.getChildren('EmphasisMark')
        if (open && close) {
          const shift = (pos: number) => Math.min(Math.max(pos, open.to), close.from) - (open.to - open.from)
          view.dispatch({ changes: [{ from: open.from, to: open.to }, { from: close.from, to: close.to }],
            selection: { anchor: shift(from), head: shift(to) } })
          view.focus()
          return
        }
      }
      const edge = bold ? '**' : '*'
      this.replace(from, to, edge + view.state.sliceDoc(from, to) + edge, from + edge.length, to + edge.length)
    },
    replace(from: number, to: number, insert: string, anchor: number, head = anchor) {
      if (view.state.doc.length - (to - from) + insert.length > limit) return false
      view.dispatch({ changes: { from, to, insert }, selection: { anchor, head }, scrollIntoView: true })
      view.focus()
      return true
    }
  }
}

type Props = { initialValue: string; onChange: (body: string) => void; readBody: (body: string) => Promise<string> }
export function MarkdownEditor({ initialValue, onChange, readBody }: Props) {
  const root = useRef<(HTMLDivElement & { stepEditor?: ReturnType<typeof controls> }) | null>(null)
  const view = useRef<EditorView | null>(null)
  const mode = useRef(new Compartment())
  const [source, setSource] = useState(() => localStorage.getItem('step-markdown-mode') === 'source')
  const [reading, setReading] = useState(false)
  const [html, setHtml] = useState('')
  const readingPanel = useRef<HTMLDivElement>(null)
  const [readingStatus, setReadingStatus] = useState('')
  const request = useRef(0)
  async function openReading() {
    if (!view.current) return
    const current = ++request.current
    const body = view.current.state.doc.toString()
    setHtml('')
    setReadingStatus('Загрузка…')
    setReading(true)
    requestAnimationFrame(() => readingPanel.current?.focus())
    try {
      const rendered = await readBody(body)
      if (current === request.current) { setHtml(rendered); setReadingStatus('') }
    } catch (error) {
      if (current === request.current) setReadingStatus(error instanceof Error ? error.message : 'Не удалось открыть шаг.')
    }
  }
  function closeReading() {
    request.current++
    setReading(false)
    requestAnimationFrame(() => { view.current?.requestMeasure(); view.current?.focus() })
  }
  const changed = useRef(onChange)
  changed.current = onChange

  useLayoutEffect(() => {
    const parent = root.current!
    const editor = new EditorView({ parent, state: EditorState.create({
      doc: initialValue,
      extensions: [
        history(), indentUnit.of('    '), markdown({ extensions: [Table] }), syntaxHighlighting(defaultHighlightStyle), EditorView.lineWrapping,
        keymap.of(['bold', 'italic'].map((name, index) => ({
          key: index === 0 ? 'Mod-b' : 'Mod-i',
          run: () => { parent.closest('[data-step]')?.querySelector<HTMLButtonElement>(`[data-action="format-${name}"]`)?.click(); return true }
        }))),
        keymap.of([
          { key: 'Mod-e', run: () => { openReading(); return true } },
          { key: 'Mod-s', run: () => { document.querySelector<HTMLButtonElement>('[data-action="save"]')?.click(); return true } },
          { key: 'Tab', run: indentMore }, { key: 'Shift-Tab', run: indentLess }
        ]),
        keymap.of([...historyKeymap, ...defaultKeymap]),
        EditorView.contentAttributes.of({ 'aria-labelledby': 'step-body-label', 'aria-multiline': 'true', spellcheck: 'true' }),
        EditorState.transactionFilter.of(tr => tr.docChanged && tr.newDoc.length > limit ? [] : tr),
        EditorView.updateListener.of(update => { if (update.docChanged) changed.current(update.state.doc.toString()) }),
        mode.current.of(source ? [] : livePreview)
      ]
    }) })
    parent.stepEditor = controls(editor)
    view.current = editor
    return () => { request.current++; delete parent.stepEditor; editor.destroy(); view.current = null }
  }, [])

  function switchMode() {
    view.current?.dispatch({ effects: mode.current.reconfigure(source ? livePreview : []) })
    localStorage.setItem('step-markdown-mode', source ? 'live' : 'source')
    setSource(!source)
    view.current?.focus()
  }

  return <><div ref={root} hidden={reading} className="step-markdown" data-mode={source ? 'source' : 'live'} />
    {reading && <div className="markdown step-reading" tabIndex={0} ref={readingPanel} onKeyDown={event => {
      if ((event.ctrlKey || event.metaKey) && event.code === 'KeyE') { event.preventDefault(); closeReading() }
    }}>{readingStatus ? <p role="status">{readingStatus}</p> : <div dangerouslySetInnerHTML={{ __html: html }} />}</div>}
    <button type="button" className="markdown-mode" onClick={reading ? closeReading : openReading}>
      {reading ? 'Редактировать' : 'Чтение'}
    </button>
    <button type="button" className="markdown-mode" hidden={reading} aria-pressed={source} onClick={switchMode}>
      {source ? 'Вернуться в живой редактор' : 'Показать исходный Markdown'}
    </button></>
}
