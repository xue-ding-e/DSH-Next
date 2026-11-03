/**
 * Restore backslashes that CommonMark ate inside Windows paths.
 *
 * CommonMark treats `\` followed by ASCII punctuation as an escape, so the
 * backslash is dropped from the rendered text: `D:\_code\_my` renders as
 * `D:_code_my`, while `C:\Users` survives only because `\U` is not punctuation.
 * That is correct for authored escapes (`\*not italic\*`) and wrong for the one
 * case where a literal `\` is ordinary prose on Windows: a path.
 *
 * This module repairs exactly that case and nothing else, by walking the source
 * character by character and deciding, for each escape the parser consumed,
 * whether the DROPPED backslash sits inside something shaped like a Windows
 * path. A dropped backslash outside a path is still dropped, so `foo\_bar` and
 * `\*not italic\*` are untouched.
 *
 * The walk produces a fresh value rather than splicing the source, because the
 * source and the parsed value differ by exactly the characters this function is
 * deciding about; splicing would resurrect escapes that must stay consumed.
 */

import type { Root, RootContent, PhrasingContent } from 'mdast'

/**
 * A Windows drive path, a UNC path, or a device path: `C:\x`, `C:/x`,
 * `\\server\share`, `\\?\C:\x`.
 *
 * A UNC opener demands a non-empty server name (or the `?`/`.` device prefix).
 * Without that requirement a bare `\\` — how Markdown writes one literal
 * backslash — would look like a UNC start and the escape would be undone.
 *
 * The tail stops at whitespace and at the punctuation that closes a sentence or
 * a Markdown construct; `\` is allowed because it is the separator being repaired.
 */
const PATH_START = /^(?:[a-zA-Z]:[\\/]|\\\\[?.]|\\\\[^\\/\s]+)/
const PATH_TAIL = /^[^\s<>"'`|?*]+/

/**
 * Characters CommonMark lets a backslash escape. A `\` immediately before one of
 * these is consumed by the parser and never reaches the output.
 */
const ESCAPABLE = /^[!"#$%&'()*+,./:;<=>?@[\\\]^_`{|}~-]$/

/**
 * Index ranges of `source` that look like Windows paths.
 * @param source - Verbatim Markdown source slice.
 * @returns Half-open `[start, end)` ranges.
 */
function windowsPathRanges(source: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  let at = 0
  while (at < source.length) {
    const head = PATH_START.exec(source.slice(at))
    if (head === null) {
      at += 1
      continue
    }
    // A path opener is only meaningful at a token boundary: it must not be part
    // of a longer word (`fooD:\x`) or follow another separator mid-segment.
    const previous = at === 0 ? ' ' : source[at - 1] ?? ' '
    if (!/[\s([{<'"`]/.test(previous) && !'，。；：、（【《'.includes(previous)) {
      at += head[0].length
      continue
    }
    let end = at + head[0].length
    const tail = PATH_TAIL.exec(source.slice(end))
    if (tail !== null) end += tail[0].length
    // Trailing punctuation belongs to the sentence, not to the path.
    while (end > at && '.,;:!?)]}'.includes(source[end - 1] ?? '')) end -= 1
    if (end > at) ranges.push([at, end])
    at = end > at ? end : at + 1
  }
  return ranges
}

/**
 * Whether a source offset falls inside any path range.
 * @param ranges - Ranges from {@link windowsPathRanges}.
 * @param offset - Source offset to test.
 * @returns True when the offset is inside a path.
 */
function inPath(ranges: ReadonlyArray<[number, number]>, offset: number): boolean {
  return ranges.some(([start, end]) => offset >= start && offset < end)
}

/**
 * Rebuild a text node's value, keeping the backslashes that belonged to paths.
 *
 * Mirrors the parser's escape pass: a `\` before ASCII punctuation is consumed;
 * every other character is copied. The only deviation is a consumed backslash
 * whose source position is inside a Windows path — that one is emitted.
 *
 * @param source - The verbatim source slice this text node covers.
 * @returns The repaired value, or undefined when no path lost a backslash.
 */
export function restoreWindowsPathBackslashes(source: string): string | undefined {
  const ranges = windowsPathRanges(source)
  if (ranges.length === 0) return undefined
  let value = ''
  let changed = false
  for (let at = 0; at < source.length; at += 1) {
    const character = source[at] ?? ''
    if (character !== '\\') {
      value += character
      continue
    }
    const next = source[at + 1]
    if (next !== undefined && ESCAPABLE.test(next)) {
      if (inPath(ranges, at)) {
        // The backslash is a path separator that happens to precede punctuation.
        value += character
        changed = true
      }
      value += next
      at += 1
      continue
    }
    value += character
  }
  return changed ? value : undefined
}

/**
 * Rewrite text nodes whose Windows paths lost backslashes to Markdown escaping.
 *
 * Only `text` nodes participate: `code`, `inlineCode`, and `html` never go
 * through the escape pass, so their backslashes are already intact. Each node is
 * checked against its own source slice, so a node that already reads correctly
 * is never rewritten, and `position` is left untouched for the incremental
 * renderer.
 *
 * @param root - Parsed Markdown tree, modified in place.
 * @param source - Original Markdown the tree was parsed from.
 * @returns The same root.
 */
export function restorePathBackslashes(root: Root, source: string): Root {
  const visit = (node: Root | RootContent): void => {
    if (node.type === 'text' && node.position !== undefined) {
      const { start, end } = node.position
      if (start.offset !== undefined && end.offset !== undefined) {
        const slice = source.slice(start.offset, end.offset)
        if (slice.includes('\\')) {
          const fixed = restoreWindowsPathBackslashes(slice)
          if (fixed !== undefined) node.value = fixed
        }
      }
    }
    if ('children' in node) {
      for (const child of node.children as PhrasingContent[]) visit(child)
    }
  }
  visit(root)
  return root
}
