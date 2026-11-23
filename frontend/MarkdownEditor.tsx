import { useLayoutEffect, useRef, useState } from 'react'
import { Compartment, EditorState, StateField } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, keymap } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { markdown } from '@codemirror/lang-markdown'
import { Table } from '@lezer/markdown'
import MarkdownIt from 'markdown-it'

const parser = new MarkdownIt({ html: false }).disable('strikethrough')
const limit = 50000

class RenderedBlock extends WidgetType {
  constructor(readonly html: string, readonly sourceLength: number) { super() }
  eq(other: RenderedBlock) { return this.html === other.html && this.sourceLength === other.sourceLength }
  toDOM(view: EditorView) {
    const block = document.createElement('div')
    block.className = 'markdown live-block'
    block.innerHTML = this.html
    block.addEventListener('mousedown', event => {
      event.preventDefault()
      const start = view.state.doc.lineAt(view.posAtDOM(block))
      const target = event.target as Element
      const row = target.closest('tr')
      let anchor = row ? view.state.doc.line(start.number + row.rowIndex + Number(row.rowIndex > 0)).from : start.from
      const caret = document.caretPositionFromPoint?.(event.clientX, event.clientY)
      const node = caret?.offsetNode
      if (node?.nodeType === Node.TEXT_NODE && target.contains(node) && node.textContent) {
        const raw = view.state.doc.sliceString(anchor, start.from + this.sourceLength)
        const index = raw.indexOf(node.textContent)
        if (index >= 0) anchor += index + caret.offset
      }
      view.dispatch({ selection: { anchor } })
      view.focus()
    })
    block.addEventListener('click', event => event.preventDefault())
    return block
  }
}

// Keep the Markdown document intact. Only its display outside the selection changes.
function parseBlocks(state: EditorState) {
  const tokens = parser.parse(state.doc.toString(), {})
  const blocks: { from: number; to: number; widget: RenderedBlock }[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (!token.map || token.level !== 0) continue
    const first = i
    if (token.nesting === 1) {
      while (i + 1 < tokens.length && !(tokens[i].level === 0 && tokens[i].nesting === -1)) i++
    }
    const from = state.doc.line(token.map[0] + 1).from
    const to = state.doc.line(token.map[1]).to
    const html = parser.renderer.render(tokens.slice(first, i + 1), parser.options, {})
    if (from < to) blocks.push({ from, to, widget: new RenderedBlock(html, to - from) })
  }
  return blocks
}

const parsed = StateField.define<ReturnType<typeof parseBlocks>>({
  create: parseBlocks,
  update: (blocks, tr) => tr.docChanged ? parseBlocks(tr.state) : blocks
})

const livePreview = [parsed, EditorView.decorations.compute([parsed, 'selection'], state => {
  const { from, to } = state.selection.main
  return Decoration.set(state.field(parsed)
    .filter(block => block.to < from || block.from > to)
    .map(block => Decoration.replace({ widget: block.widget, block: true }).range(block.from, block.to)))
})]

function controls(view: EditorView) {
  return {
    get value() { return view.state.doc.toString() },
    get selection() { return view.state.selection.main },
    replace(from: number, to: number, insert: string, anchor: number, head = anchor) {
      if (view.state.doc.length - (to - from) + insert.length > limit) return false
      view.dispatch({ changes: { from, to, insert }, selection: { anchor, head }, scrollIntoView: true })
      view.focus()
      return true
    }
  }
}

export function MarkdownEditor({ initialValue, onChange }: { initialValue: string; onChange: (body: string) => void }) {
  const root = useRef<(HTMLDivElement & { stepEditor?: ReturnType<typeof controls> }) | null>(null)
  const view = useRef<EditorView | null>(null)
  const mode = useRef(new Compartment())
  const [source, setSource] = useState(() => localStorage.getItem('step-markdown-mode') === 'source')
  const changed = useRef(onChange)
  changed.current = onChange

  useLayoutEffect(() => {
    const parent = root.current!
    const editor = new EditorView({ parent, state: EditorState.create({
      doc: initialValue,
      extensions: [
        history(), markdown({ extensions: [Table] }), syntaxHighlighting(defaultHighlightStyle), EditorView.lineWrapping,
        keymap.of(['bold', 'italic'].map((name, index) => ({
          key: index === 0 ? 'Mod-b' : 'Mod-i',
          run: () => { parent.closest('[data-step]')?.querySelector<HTMLButtonElement>(`[data-action="format-${name}"]`)?.click(); return true }
        }))),
        keymap.of([...historyKeymap, ...defaultKeymap]),
        EditorView.contentAttributes.of({ 'aria-labelledby': 'step-body-label', 'aria-multiline': 'true', spellcheck: 'true' }),
        EditorState.transactionFilter.of(tr => tr.docChanged && tr.newDoc.length > limit ? [] : tr),
        EditorView.updateListener.of(update => { if (update.docChanged) changed.current(update.state.doc.toString()) }),
        mode.current.of(source ? [] : livePreview)
      ]
    }) })
    parent.stepEditor = controls(editor)
    view.current = editor
    return () => { delete parent.stepEditor; editor.destroy(); view.current = null }
  }, [])

  function switchMode() {
    view.current?.dispatch({ effects: mode.current.reconfigure(source ? livePreview : []) })
    localStorage.setItem('step-markdown-mode', source ? 'live' : 'source')
    setSource(!source)
    view.current?.focus()
  }

  return <><div ref={root} className="step-markdown" />
    <button type="button" className="markdown-mode" aria-pressed={source} onClick={switchMode}>
      {source ? 'Вернуться в живой редактор' : 'Показать исходный Markdown'}
    </button></>
}
