---
name: dsh-client-ui-ux
description: Design and review DeepSeek Harness client UI changes — visual tokens, reusable components, Lexical editor callbacks, drag feedback, native desktop notifications, overlay and menu safety, platform window adaptation, loading states, and error placement. Use when adding or changing product-user-visible GUI behavior in packages/client, or when reviewing such a PR.
---

# DeepSeek Harness Client UI/UX

This skill is guidance, not a complete checklist. It covers judgment calls that lint, typecheck, and the i18n gate cannot make: where feedback appears, what gets reused, and how surfaces behave at window edges and across platforms. Copy quality itself follows [dsh-prose-standard](../dsh-prose-standard/SKILL.md); locale ownership follows the [locale-owned copy decision](../../notes/implemented/architecture/2026-08-23-locale-owned-client-ui-copy.md); styling ownership and token rules live in [docs/web-styling.md](../../../docs/web-styling.md) and the [ui-primitives component catalog](../../../packages/client/ui-primitives/README.md#component-catalog) — this skill adds judgment on top of those rules, not a second copy of them.

## Architecture prerequisites

Component structure, state flow, and effect usage follow the architecture rules; read them before redesigning a component:

- [packages/client/AGENTS.md](../../../packages/client/AGENTS.md) — Slot and props discipline, reactive read, export, ctx, and layering rules.
- [Client component rules](../../../docs/defensive-patterns/client-components.md) — those requirements stated with the defects they prevent.

## Visual foundation

- **Use existing tokens for color, radius, and spacing.** Before introducing a literal value, search the target page and its nearest established sibling (the Plugins page is the usual reference for full-page surfaces) for the token or value already in use, and adopt it. The same applies to whole treatments — toasts, menus, in-message artifact previews, sidebar tab layout, colors, clearance rules, page padding: reuse the established component or rule wherever one exists instead of inventing a parallel one.
- **Verify every color in both light and dark mode.** An ink/background pair must stay readable under both themes before it ships. Dimmed tones are the standing counter-example: they suit decorative surfaces, but on text they routinely fall below readability in one theme — never put a dimmed color on text without checking both.
- **Font weight tops out at 500 in feature CSS you add or change.** Do not use 600+ for emphasis; differentiate with size or ink instead. The markdown typography tokens owned by ui-theme are the standing exception.
- **Pick font sizes from the theme typography variables when an existing role matches, otherwise from the page's existing scale.** Parallel content shares one size; never invent a size for a single element, and keep the number of distinct sizes on a page small (13px is the established row/detail size). When the page itself has no precedent, borrow the size and spacing ratios of the most similar existing page or element.
- **Icons, text, and neighbouring elements stay proportionate and aligned.** Every element lines up with its siblings along a deliberate axis (baseline, vertical center, or shared edge), and an icon's size stays in proportion to the text beside it; never ship an element that aligns to nothing or visibly outweighs its neighbours.

## Reuse before adding

- **Extend an existing component, container, or interaction before creating a new one.** A new capability that fits an existing surface (an extra menu item, a new prop on an existing primitive) beats a parallel element stacked beside it.
- **Icons come from the existing icon library.** Pick the semantically closest existing icon; a new glyph requires designer approval before it lands — when reviewing a PR that adds one, suggest requesting a designer review.
- **Right-sidebar content registers a slot in the existing sidebar**, never a separate sidebar. Every sidebar tab declares a tab icon matching its meaning.
- **Icon-only actions whose meaning is not obvious get a Tooltip.** Informational content the pointer must rest on or select uses HoverCard instead. Prefer these shared primitives over ad-hoc title attributes.

## Feedback surfaces

Apply [dsh-error-handling](../dsh-error-handling/SKILL.md#localized-actionable-visible-reports) to failure reports. Choose the surface by the lifetime of the message relative to the surface that produced it:

- **Transient operation outcomes use the app-wide Toast primitive**, not in-place notices, and the toast's state and rendering live in a host that outlives the reporting surface (a `shell.overlay` entry, as RowActionToast does) — a toast rendered by the panel itself unmounts with that panel. A deletion can close the panel or tab that requested it; only a toast held outside that surface survives the close. Report success and failure; do not report still-pending states.
- **A failed operation keeps the data visible.** A failed deletion keeps its row; the toast announces the failure. Never blank content to show an error for a transient operation.
- **In-place notices are for states tied to the surface itself**: a query failure with its Retry action, field validation on the form that owns the field. A populated panel keeps a compact notice beside its retained content; only an empty panel centers a full error state.
- **Error copy is plain language, and short.** No internal jargon or technical nouns unless an error code must be exposed for debugging. Prefer one clear sentence; anything explainable in two sentences must not grow into paragraphs. A Chinese notice of at most two sentences omits the trailing 句号（。）. The notice must not break the existing layout — reserve its space or overlay it; never shift neighbouring elements.

## Native desktop notifications

Use the Desktop preload IPC for system notifications, with the main process checking the product origin, owning window, and main frame. A request for desktop system notifications uses the OS notification area; do not also show the Web client's in-app reminder card or substitute that card when native delivery fails. Report a delivery failure while keeping the question answerable. An in-app card does not verify notification delivery outside the app. Clicking a reminder restores the window, opens its Session, and reveals the still-answerable question; receiving a reminder does not move focus.

On Windows, the [Electron `close` event](https://www.electronjs.org/docs/latest/api/notification#event-close) can mean that the banner timed out while its notification-center entry remains actionable. Keep its click handler until the question resolves, the preference disables notifications, or the owning document ends. Test timeout followed by activation, replacement, resolution, document navigation, and disposal racing submission. Unit tests of Electron calls establish bridge behavior; verify actual Windows display and activation in an isolated desktop profile before claiming OS delivery. Report unsupported delivery and native failure without making the question unavailable.

For Windows delivery diagnosis, distinguish `Notification.show()` submission, its native `show` event, an entry in Windows notification history, and visible banner/activation evidence. Record explicit `Notification.close()` calls separately from OS `close` events. `SHQueryUserNotificationState` reports `QUNS_BUSY` (2) for fullscreen or presentation conditions and `QUNS_ACCEPTS_NOTIFICATIONS` (5) when these conditions are absent; it does not replace checking Windows do-not-disturb behavior. Do not change the user's notification preferences to force a banner. The user can confirm a visible banner and click while the isolated app records its native activation event.

Windows PowerShell 5.1 can inspect only the test application's notification history through `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]`, then `::History.GetHistory(appId)` and `::CreateToastNotifier(appId).Setting`. Invoke its explicit executable when the default shell is PowerShell 7, which may reject that WinRT type. Do not enumerate other applications' notifications. In Electron 44.7.0, the automatic Start Menu shortcut name and fallback identity use the executable's PE product name; `app.setName()` alone does not brand the Windows notification sender. Verify development executable branding separately from packaged identity.

## Loading states

- Lists use their skeleton; every other page-level load centers a bare spinner. Never place a spinner in a corner of the page.
- One loading treatment per page/component — concurrent regions must not each flash their own style.
- No loading text unless the context needs it (narrow sidebars almost never do).

## Composer editor focus

In native DOM callbacks under the repository's patched Lexical 0.49.0, DOM-node queries such as `$getNearestNodeFromDOMNode` need the active editor as well as its state. First filter the event target with `closest('[data-composer-chip]')` and verify that the editor root contains it; ordinary text and empty-area clicks return before calling Lexical query functions. Resolve a matched chip inside `editor.read(() => ...)`. Calling `editor.getEditorState().read(() => ...)` alone did not provide the active editor in this tested path and raised Lexical error #337.

The [native activation unit](../../../packages/client/ui-conversation/tests/session-reference-activation.client.spec.ts) verifies that ordinary root/text clicks do not call `editor.read`, and nested chip DOM resolves without an editor-context exception. The [browser navigation scenarios](../../../apps/web/tests/reference-navigation.e2e.ts) exercise actual mouse clicks, modifier combinations, selection, navigation, and draft restoration with a console-error tripwire. Recheck this API behavior against the installed Lexical version when it changes.

For the repository's patched Lexical 0.49.0, editable listeners run while the editor queues updates. Restore a recalled draft's focus and selection in a `queueMicrotask` after that callback returns; an editor update inside the callback can remain pending until the next keystroke. Capture the initiating root, then recheck editability, disposal, root identity, and whether another control owns focus before applying the deferred change. The shell owns and cancels pending editable/root listener registrations on disposal, including when the root remains attached and never re-enables; a disposed guard inside a future callback does not release those registrations. A root-listener disposer also invokes its listener with `null`, so cleanup must tolerate reentry.

Verify the native caret and type through `page.keyboard.type()` without refocusing in [queue-recall-focus.e2e.ts](../../../apps/web/tests/queue-recall-focus.e2e.ts). jsdom editor-command tests alone cannot establish DOM caret placement. Recheck this ordering against the installed Lexical implementation when its version changes.

A queue recall retains its original Session while the Host reply is pending. If that Session's view unmounts, keep the initiating draft writer available to the operation and save the recalled draft before acknowledging recovery and releasing the Session. Verify switching away during the request, returning, and reloading; the other Session's draft and the remaining queue must stay intact.

## Overlays and menus

Every menu, popover, and tooltip must be verified for all three before merge:

- **Dismissable**: outside click (and Escape where focusable) closes it.
- **Viewport-fitting**: it slides or flips to stay inside the window with an edge margin, and flips only into a side that actually fits (no oscillation when neither side fits).
- **Unclipped**: it escapes `overflow` ancestors and containing blocks (portal to body where needed) and is never covered by neighbouring elements.

Scrollbars stay inside their container: use the shared scrollbar styles rather than component-specific selectors, and verify the bar neither overflows the container nor gets clipped by its rounded corners or edges — keep a small inset instead of letting it sit flush against the container edge.

## Conversation drag feedback

Sidebar conversation references use the main content and right panel as the receiving area, with a visible blue overlay and localized release hint; requiring a drop directly on the input card is too narrow. Insert into the current draft while preserving its selection, text, chips, attachments, and queued messages. Returning to the sidebar preserves its own reorder behavior, and a reference drop elsewhere does not commit a hovered reorder position. Clear feedback when the pointer leaves the receiving area, the drag ends or is cancelled, the window loses focus, or the receiving composer unmounts. Keep ordinary file intake separate.

Verify the invitation while a native browser drag is still held, then release on blank conversation space and on the right panel. Assert the resulting chip, retained draft and focus, sidebar order, and overlay removal. A unit `drop` event alone cannot verify the receiving area's size or visible guidance.

## Responsive layouts

Use [dsh-responsive-ui](../dsh-responsive-ui/SKILL.md) for responsive layouts, mobile and touch detection, text truncation, title wrapping, icon-only controls, and focus during width changes.

## Platform window adaptation

- Any new header element or full page must account for macOS and Windows window chrome. On macOS the titlebar clearance is `--dsh-frame-top-clearance`, consumed by Menu, Modal, and overlay primitives as their top safe margin — **never change the global variable to fix one page**. Add a scoped `[data-platform='darwin']` override on the page's own inset instead, and assert the override in the page's stylesheet spec.
- State the intended total offset (clearance + page inset) when reviewing, so two pages aligning to "the same top spacing" agree on the sum, not just one addend.

## Spacing review

- Review every changed region for gaps: nothing sits flush against its neighbour without an intentional gap, and adjacent icons and elements keep the region's established spacing.
- Prefer symmetry for parallel elements; an unexplained one-off gap or offset usually signals a missed shared value.

## Design review escalation

- A PR with extensive UI changes, or any clearly user-perceivable change to UI or interaction, must get a designer or product review. When no approver holds that role, suggest requesting one from the design/product reviewers (roster as of 2026-09: yx zhang, yifffan, zhangziya, gaokaige; update this list here when membership changes).
