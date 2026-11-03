import { describe, expect, it } from 'vitest'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfm } from 'micromark-extension-gfm'
import type { Root, RootContent } from 'mdast'
import { extractMarkdownPlainText } from '@deepseek-ai/dsh-client-ui-primitives'
import { restorePathBackslashes, restoreWindowsPathBackslashes } from '../src/markdown/pathBackslashes.ts'

/** Visit every node in the tree, regardless of block or inline position. */
function walk(node: Root | RootContent, visit: (node: RootContent) => void): void {
  visit(node as RootContent)
  if ('children' in node) {
    for (const child of node.children) walk(child, visit)
  }
}

/** Text the renderer would draw for this tree, concatenated. */
function drawnText(root: Root): string {
  let text = ''
  walk(root, (node) => {
    if (node.type === 'text') text += node.value
  })
  return text
}

/**
 * Parse one GFM paragraph the way the streaming arm does, with and without the
 * path repair, so each assertion states both what CommonMark produced and what
 * the renderer shows.
 */
function render(source: string): { parsed: string; rendered: string } {
  const root = fromMarkdown(source, { extensions: [gfm({ singleTilde: false })] })
  const parsed = drawnText(root)
  restorePathBackslashes(root, source)
  return { parsed, rendered: drawnText(root) }
}

describe('restoreWindowsPathBackslashes', () => {
  it('keeps the backslash of a drive path whose next segment starts with punctuation', () => {
    // `\_` is an ASCII-punctuation escape, so CommonMark drops the separator.
    expect(render('D:\\_code\\_开源项目\\DSH-Next')).toEqual({
      parsed: 'D:_code_开源项目\\DSH-Next',
      rendered: 'D:\\_code\\_开源项目\\DSH-Next',
    })
  })

  it('leaves a path unchanged when CommonMark already preserved it', () => {
    // `\U` is not punctuation, so this path never lost anything; the repair must
    // not double the separator.
    expect(render('C:\\Users\\test')).toEqual({
      parsed: 'C:\\Users\\test',
      rendered: 'C:\\Users\\test',
    })
  })

  it('repairs inside a sentence without touching a later real escape', () => {
    expect(render('path D:\\a\\_b and escape \\_here').rendered)
      .toBe('path D:\\a\\_b and escape _here')
  })

  it('repairs UNC and device paths', () => {
    expect(render('\\\\server\\share\\_dir').rendered).toBe('\\\\server\\share\\_dir')
    expect(render('\\\\?\\C:\\_long\\_path').rendered).toBe('\\\\?\\C:\\_long\\_path')
  })

  it('leaves authored escapes outside paths collapsed', () => {
    expect(render('foo\\_bar intentional escape').rendered).toBe('foo_bar intentional escape')
    expect(render('a\\*b\\* not italic').rendered).toBe('a*b* not italic')
    expect(render('\\_leading').rendered).toBe('_leading')
  })

  it('stops the path at whitespace so following prose keeps its escapes', () => {
    expect(render('D:\\_code 后面还有中文').rendered).toBe('D:\\_code 后面还有中文')
    expect(restoreWindowsPathBackslashes('D:\\_code and \\_escaped')).toBe('D:\\_code and _escaped')
  })

  it('reports no change when no path lost a backslash', () => {
    for (const source of ['no path at all', 'C:/_unix/style', 'C:\\Users\\me']) {
      expect(restoreWindowsPathBackslashes(source)).toBeUndefined()
    }
  })

  it('does not mistake an escaped backslash pair for a UNC opener', () => {
    // `\\` is how Markdown writes one literal backslash. A UNC pattern that
    // accepts an empty server name reads it as a path start and undoes the
    // escape, which regressed the entities-and-escapes DOM parity fixture.
    expect(render('backslash \\\\ literal').rendered).toBe('backslash \\ literal')
    expect(restoreWindowsPathBackslashes('backslash \\\\ literal')).toBeUndefined()
  })

  it('is a pure function: the same source always yields the same result', () => {
    // Guards the shared-regex trap: a module-level sticky cursor would make the
    // second call resume where the first stopped.
    const source = 'D:\\_code\\_a then \\\\srv\\_b'
    const first = restoreWindowsPathBackslashes(source)
    const second = restoreWindowsPathBackslashes(source)
    expect(first).toBe(second)
    expect(first).toBe('D:\\_code\\_a then \\\\srv\\_b')
  })

  it('does not touch code spans or fenced blocks', () => {
    const source = 'inline `D:\\_code\\_x` and bare D:\\_code\\_y'
    const root = fromMarkdown(source, { extensions: [gfm({ singleTilde: false })] })
    const codes = (): string[] => {
      const found: string[] = []
      walk(root, (node) => {
        if (node.type === 'inlineCode' || node.type === 'code') found.push(node.value)
      })
      return found
    }
    const before = codes()
    restorePathBackslashes(root, source)
    // Code spans never went through the escape pass, so their value is already
    // correct and the repair must leave it byte-identical.
    expect(codes()).toEqual(before)
    expect(before).toEqual(['D:\\_code\\_x'])
  })
})

describe('path repair through the plain-text projection', () => {
  it('projects the repaired path rather than the escape-consumed one', () => {
    expect(extractMarkdownPlainText('stored at D:\\_code\\_data now'))
      .toBe('stored at D:\\_code\\_data now')
  })
})
