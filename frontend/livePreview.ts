import { EditorState, StateField } from '@codemirror/state'
import type { Range } from '@codemirror/state'
import { Decoration, EditorView, WidgetType } from '@codemirror/view'
import { parser, Table } from '@lezer/markdown'
import MarkdownIt from 'markdown-it'

const syntax = parser.configure(Table)
const markdown = new MarkdownIt({ html: false })

function blockAt(view: EditorView, pos: number) {
  return [...view.contentDOM.querySelectorAll('.live-block')].find(el => view.posAtDOM(el) === pos)
}

class Media extends WidgetType {
  constructor(readonly source: string, readonly table: boolean) { super() }
  eq(other: Media) { return this.source === other.source && this.table === other.table }
  toDOM(view: EditorView) {
    const el = document.createElement(this.table ? 'div' : 'span')
    el.className = 'markdown live-block'
    el.innerHTML = this.table ? markdown.render(this.source) : markdown.renderInline(this.source)
    el.addEventListener('mousedown', event => {
      if (event.target instanceof HTMLInputElement) return
      event.preventDefault()
      const start = view.posAtDOM(el)
      const cell = (event.target as Element).closest('th,td') as HTMLTableCellElement | null
      let anchor = start
      if (cell && cell.parentElement instanceof HTMLTableRowElement) {
        const previous = el.querySelector('input')
        if (previous) {
          const index = [...el.querySelectorAll('td,th')].indexOf(cell)
          previous.blur()
          blockAt(view, start)?.querySelectorAll('td,th')[index]?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
          return
        }
        const row = cell.parentElement.rowIndex
        const line = view.state.doc.line(view.state.doc.lineAt(start).number + row + Number(row > 0))
        // Empty columns are omitted from the syntax tree; split the row at its real delimiters.
        const delimiters = [...line.text.matchAll(/(?<!\\)\|/g)].map(m => m.index)
        const left = /^\s*\|/.test(line.text) ? delimiters.shift()! + 1 : 0
        const starts = [left, ...delimiters.map(i => i + 1)]
        const rawFrom = starts[cell.cellIndex]
        if (rawFrom !== undefined) {
          editTableCell(view, el, cell, line.from + rawFrom, line.from + (delimiters[cell.cellIndex] ?? line.length))
          return
        }
        anchor = line.to
      }
      view.dispatch({ selection: { anchor } })
      view.focus()
    })
    return el
  }
}

function editTableCell(view: EditorView, table: HTMLElement, cell: HTMLTableCellElement, from: number, to: number) {
  const pos = view.posAtDOM(table)
  const original = [...cell.childNodes]
  const input = document.createElement('input')
  input.className = 'lp-cell-input'
  input.setAttribute('aria-label', 'Текст ячейки')
  const raw = view.state.sliceDoc(from, to)
  input.value = raw.trim()
  cell.replaceChildren(input)
  input.focus()
  input.select()
  let done = false
  function finish(save: boolean) {
    if (done) return
    done = true
    const value = input.value
    cell.replaceChildren(...original)
    if (save && value !== raw.trim()) {
      const insert = ' ' + value.replace(/(?<!\\)\|/g, '\\|') + ' '
      view.dispatch({ changes: { from, to, insert }, userEvent: 'input' })
    }
  }
  input.addEventListener('blur', () => finish(true), { once: true })
  input.addEventListener('keydown', event => {
    if (!['Enter','Tab','Escape'].includes(event.key)) return
    event.preventDefault()
    event.stopPropagation()
    const index = [...table.querySelectorAll('td,th')].indexOf(cell) + (event.shiftKey ? -1 : 1)
    finish(event.key !== 'Escape')
    if (event.key === 'Tab' && index >= 0) {
      const current = blockAt(view, pos)
      const target = current?.querySelectorAll('td,th')[index]
      if (target) { target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return }
    }
    view.focus()
  })
}

class Bullet extends WidgetType {
  toDOM() { const el = document.createElement('span'); el.textContent = '•'; return el }
}

type Part = { range: Range<Decoration>; reveal?: [number, number] }

// Keep prose in CodeMirror's own text nodes so clicking, dragging and keyboard
// selection resolve to real document offsets, even for repeated words.
function parts(state: EditorState) {
  const doc = state.doc
  const source = doc.toString()
  const tree = syntax.parse(source)
  const result: Part[] = []
  const mark = (from: number, to: number, className: string) =>
    result.push({ range: Decoration.mark({ class: className }).range(from, to) })
  const lineClass = (pos: number, name: string) =>
    result.push({ range: Decoration.line({ class: name }).range(doc.lineAt(pos).from) })
  const hide = (from: number, to: number, reveal: [number, number], widget?: WidgetType, block = false) => {
    if (to > from) result.push({ range: Decoration.replace({ widget, block }).range(from, to), reveal })
  }
  tree.iterate({ enter(ref) {
    const { name, from, to, node } = ref
    const line = doc.lineAt(from)
    const activeLine: [number, number] = [line.from, line.to]
    if (name === 'Image' || name === 'Table') {
      hide(from, to, [from, to], new Media(source.slice(from, to), name === 'Table'), name === 'Table')
      return false
    }
    if (name === 'Blockquote') {
      const header = /^>\s*\[!(warning|tip|note)\]/i.exec(source.slice(from, line.to))
      const kind = header?.[1].toLowerCase()
      for (let n = line.number; n <= doc.lineAt(to - 1).number; n++)
        lineClass(doc.line(n).from, kind ? 'lp-callout callout-' + kind : 'lp-quote')
      if (header) {
        lineClass(from, 'lp-callout-title')
        hide(from + header[0].indexOf('['), from + header[0].length, activeLine)
      }
    } else if (name === 'QuoteMark' || name === 'HeaderMark') {
      hide(from, to + Number(source[to] === ' '), activeLine)
    } else if (/^ATXHeading[1-6]$/.test(name)) {
      lineClass(from, 'lp-heading lp-h' + name.slice(-1))
    } else if (name === 'ListMark' && /^[-+*]$/.test(source.slice(from, to))) {
      hide(from, to, activeLine, new Bullet())
    } else if (name === 'StrongEmphasis' || name === 'Emphasis' || name === 'InlineCode') {
      mark(from, to, { StrongEmphasis: 'lp-strong', Emphasis: 'lp-em', InlineCode: 'lp-code' }[name])
      for (const edge of node.getChildren(name === 'InlineCode' ? 'CodeMark' : 'EmphasisMark'))
        hide(edge.from, edge.to, [from, to])
    } else if (name === 'Link' && node.getChild('URL')) {
      const edges = node.getChildren('LinkMark')
      if (edges.length >= 3) {
        mark(from, to, 'lp-link')
        hide(from, edges[0].to, [from, to])
        hide(edges[1].from, to, [from, to])
      }
    }
  } })
  for (const match of source.matchAll(/(?<![\p{L}\p{N}_/#])#[\p{L}_][\p{L}\p{N}_/-]*/gu)) {
    let node = tree.resolveInner(match.index, 1)
    while (node.parent && !['InlineCode','FencedCode','CodeBlock','URL','Image','Table'].includes(node.name))
      node = node.parent
    if (!node.parent) mark(match.index, match.index + match[0].length, 'lp-tag')
  }
  return result
}

const parsed = StateField.define<Part[]>({
  create: parts,
  update: (previous, tr) => tr.docChanged ? parts(tr.state) : previous
})

export const livePreview = [parsed, EditorView.decorations.compute([parsed, 'selection'], state => {
  const selection = state.selection.ranges
  return Decoration.set(state.field(parsed).filter(({ reveal }) => !reveal ||
    !selection.some(range => range.from <= reveal[1] && range.to >= reveal[0])).map(part => part.range), true)
})]
