---
name: dsh-client-ui-ux
description: Design and review DeepSeek Harness user-visible UI changes: visual tokens, reusable components, Lexical editor focus, alignment, spacing, geometry, interaction, conversation drag feedback, native desktop notifications, overlay and menu safety, platform adaptation, loading states, and error placement. Use before changing UI in client, experimental, or app packages; verify affected rendered results before handoff.
---

# DeepSeek Harness UI development

Use this skill as the entry point for UI design and review. It owns the workflow, visual foundation, geometry and interaction guidance; alignment, spacing and icon details live in its references below. Load only the references relevant to the task; examples explain judgment, not coverage.

<a id="required-review-loop"></a>
## UI change workflow

Use applicable design rules for UI changes, including visible loading, error, disabled, expanded and focus states. Choose effort by impact and regression risk; ordinary development does not require a full design audit.

| Change | Required inspection | Additional records |
|---|---|---|
| Local copy, icon reuse, color or spacing | Inspect the actual page, affected neighbors and relevant states; run applicable tests. Apply the minimum checks below. | Briefly report results and material gaps. No separate plan, axis drawing, scene inventory, source snapshot or screenshot report is required by default. |
| Page layout, shared components or global styles | Identify affected relationships and consumers; inspect distinct affected layout, content and state variants in assembled pages. Reuse evidence only for justified equivalents. | Briefly state scope. Preserve the starting version and comparable images when requested or needed to explain broad changes or assess regression risk. |
| Explicit comprehensive review | Cover the agreed regions and relevant states; distinguish inspected results, defects and uninspected scope. | Use the [review cookbook](../../../docs/cookbook/reviewing-ui-design.md) for coverage records, findings and supporting evidence. A comparison request alone does not require a product-wide audit. |

### Minimum checks for affected UI

These checks apply even to small changes; optional documentation does not make inspection optional. Open the actual page and inspect the changed element with its directly affected neighbors, rather than judging CSS or an isolated component alone.

- **Color or opacity:** inspect light and dark themes, including affected foreground/background and state combinations.
- **Layout, spacing, typography or sizing:** inspect a constrained container and long or wrapping content; check both sides of a changed breakpoint, alignment, clipping and access to actions.
- **Interaction:** exercise the changed path and affected focus, disabled, loading, error, expanded and overlapping states. Check only states the change can affect, not every possible combination.
- **Shared components or global styles:** trace affected consumers and inspect distinct assembled layouts and states; one isolated example cannot establish coverage.

If a required scene is unavailable, state what was not checked, why and how it can be verified; a labeled production-component fixture can provide partial evidence, not an actual-page pass. Do not claim verification complete while required checks remain missing. Run the original applicable tests; source inspection and passing tests alone do not establish the rendered result.

Read unchanged owners once; consult examples for uncertain judgments. Inspect relevant states and actual usage sizes, not a fixed screenshot count or every width × theme × state combination. Batch related edits and reuse a current application instance and valid evidence. Documentation-only changes and refactors with evidence of unchanged rendering need no new UI captures; state that basis.

When a before/after comparison is needed, preserve the actual starting implementation, including uncommitted work, and use comparable capture conditions. Never recreate a missing before image and present it as an original. Protect existing work regardless of whether extra evidence is needed.

Before handoff, review or push, check only new cumulative interactions, missing required checks and invalidated evidence; do not repeat completed verification at each stage. Report results and material gaps accurately. Do not claim full coverage or visual acceptance when required scenes or checks are missing.

These effort levels change only the additional design-review procedure. Existing [client test requirements](../../../packages/client/AGENTS.md), [GUI PR GIF requirements](../record-browser-gif/SKILL.md#every-gui-pull-request-includes-a-gif), and [designer/product approval](#design-review-escalation) still apply, including to local changes when their original triggers are met.

## Select the rule owners

For layout changes, read the alignment and spacing references. Read the icon reference when selecting, drawing or reviewing artwork, or when adding, changing or reviewing icon buttons, icon-only actions or informational icons, including reuse without artwork changes. Other tasks use the relevant sections below. Do not load all references by default. Existing responsive and official-artwork skills retain their scopes; numeric scales stay with their implementation owners.

| Decision needed before implementation | Section or reference |
|---|---|
| Shared axes, text starts, centering, tree indentation, complete icon boxes | [Alignment](references/alignment.md) |
| Semantic groups, inner/outer gaps, repeated rhythm, section separation | [Spacing and grouping](references/spacing.md) |
| Interface icon selection and artwork; icon buttons and icon-only actions, tooltips, informational hover content, accessible labels and focus | [Icons](references/icons.md) |
| Color, typography and existing treatments | [Visual foundation](#visual-foundation); [Web styling](../../../docs/web-styling.md) owns tokens/materials |
| Component geometry, nested contours and state fills | [Geometry decisions](#component-geometry); [radius standard](../../../docs/ui-radius.md) owns values and exceptions |
| Feedback lifetime, loading, overlays, scrolling and platform clearance | [Interaction and feedback](#interaction-and-feedback); [error handling](../dsh-error-handling/SKILL.md) owns failure guarantees |
| Responsive layout rules, mobile-specific interactions, and truncation/ellipsis rules for components like text and buttons | [Responsive UI](../dsh-responsive-ui/SKILL.md) |
| Official plugin artwork and feature previews | [Official artwork](../dsh-official-plugin-artwork/SKILL.md) |
| Copy, locale ownership and component semantics | [Prose standard](../dsh-prose-standard/SKILL.md), [locale ownership](../../notes/implemented/architecture/2026-08-23-locale-owned-client-ui-copy.md), [primitives catalog](../../../packages/client/ui-primitives/README.md#component-catalog) |
| Density, information hierarchy, combined control states and component choice | [Principle reference](../../../docs/ui-design-review-cases.md#density) sections 3–6 |

## Reuse before adding

Extend existing components, containers and interactions when the capability fits. Register right-sidebar content through a slot in the existing sidebar; do not create a separate sidebar. Follow [icon reuse](references/icons.md#reuse-existing-icons-first). Before restructuring, read [client instructions](../../../packages/client/AGENTS.md) and [client defensive patterns](../../../docs/defensive-patterns/client-components.md) for component/state ownership and layering.

## Visual foundation

- Reuse tokens, values and complete treatments from the target page or nearest established sibling before adding literals; Plugins is the usual full-page reference.
- Verify colors in light and dark themes; keep ink/background pairs readable, especially dimmed text.
- Feature CSS you add or change uses **font weight ≤500**; emphasize with size or ink. ui-theme markdown typography tokens are the exception.
- Use theme typography roles, then the page's scale, then a comparable page's size/spacing ratios. Do not invent a size for a single element. Peers share sizes; keep the scale small (13px is the established row/detail size).
- Apply [alignment](references/alignment.md) and the [same-foreground rule](references/icons.md#placement-and-use) to icon/text relationships, including value chevrons and search prompts.

## Component geometry

Choose component role and size variant, then its container relationship. Compare height, radius, curve, inset and material together; equal radii alone do not establish coherence, and wrapping/expansion alone does not justify larger radii. [Radius standards](../../../docs/ui-radius.md#radius-scale) own values and exceptions.

## Native desktop notifications

Use the Desktop preload IPC for system notifications, with the main process checking the product origin, owning window, and main frame. A request for desktop system notifications uses the OS notification area; do not also show the Web client's in-app reminder card or substitute that card when native delivery fails. Report a delivery failure while keeping the question answerable. An in-app card does not verify notification delivery outside the app. Clicking a reminder restores the window, opens its Session, and reveals the still-answerable question; receiving a reminder does not move focus.

On Windows, the [Electron `close` event](https://www.electronjs.org/docs/latest/api/notification#event-close) can mean that the banner timed out while its notification-center entry remains actionable. Keep its click handler until the question resolves, the preference disables notifications, or the owning document ends. Test timeout followed by activation, replacement, resolution, document navigation, and disposal racing submission. Unit tests of Electron calls establish bridge behavior; verify actual Windows display and activation in an isolated desktop profile before claiming OS delivery. Report unsupported delivery and native failure without making the question unavailable.

For Windows delivery diagnosis, distinguish `Notification.show()` submission, its native `show` event, an entry in Windows notification history, and visible banner/activation evidence. Record explicit `Notification.close()` calls separately from OS `close` events. `SHQueryUserNotificationState` reports `QUNS_BUSY` (2) for fullscreen or presentation conditions and `QUNS_ACCEPTS_NOTIFICATIONS` (5) when these conditions are absent; it does not replace checking Windows do-not-disturb behavior. Do not change the user's notification preferences to force a banner. The user can confirm a visible banner and click while the isolated app records its native activation event.

Windows PowerShell 5.1 can inspect only the test application's notification history through `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]`, then `::History.GetHistory(appId)` and `::CreateToastNotifier(appId).Setting`. Invoke its explicit executable when the default shell is PowerShell 7, which may reject that WinRT type. Do not enumerate other applications' notifications. In Electron 44.7.0, the automatic Start Menu shortcut name and fallback identity use the executable's PE product name; `app.setName()` alone does not brand the Windows notification sender. Verify development executable branding separately from packaged identity.

## Loading states

- **Inset:** coordinate inner/outer curves and inset. Radius subtraction is exact for concentric circular arcs; for superellipses, subtraction is only a nominal sizing rule, so inspect diagonal whitespace as well as side gaps.
- **Flush or adjoining:** the enclosure owns exposed corners; internal joins stay square. Hover fills and pseudo-elements follow that contour without clipping menus or focus.
- **Independent child card/group:** use its own role/size tier, not the dialog radius or subtraction of all parent padding.
- **Circles/capsules:** preserve shape, including avatar container and image, using the theme's round-curve exception; ordinary controls use the shared curve.

Keep fills, strokes and overlays geometrically stable across hover, pressed, selected, loading and disabled states. Reuse [card/elevation materials](../../../docs/ui-radius.md#settings-cards): shadows already include neutral hairlines; retain semantic state-colored borders without doubling neutral edges.

## Composer editor focus

In native DOM callbacks under the repository's patched Lexical 0.49.0, DOM-node queries such as `$getNearestNodeFromDOMNode` need the active editor as well as its state. First filter the event target with `closest('[data-composer-chip]')` and verify that the editor root contains it; ordinary text and empty-area clicks return before calling Lexical query functions. Resolve a matched chip inside `editor.read(() => ...)`. Calling `editor.getEditorState().read(() => ...)` alone did not provide the active editor in this tested path and raised Lexical error #337.

The [native activation unit](../../../packages/client/ui-conversation/tests/session-reference-activation.client.spec.ts) verifies that ordinary root/text clicks do not call `editor.read`, and nested chip DOM resolves without an editor-context exception. The [browser navigation scenarios](../../../apps/web/tests/reference-navigation.e2e.ts) exercise actual mouse clicks, modifier combinations, selection, navigation, and draft restoration with a console-error tripwire. Recheck this API behavior against the installed Lexical version when it changes.

For the repository's patched Lexical 0.49.0, editable listeners run while the editor queues updates. Restore a recalled draft's focus and selection in a `queueMicrotask` after that callback returns; an editor update inside the callback can remain pending until the next keystroke. Capture the initiating root, then recheck editability, disposal, root identity, and whether another control owns focus before applying the deferred change. The shell owns and cancels pending editable/root listener registrations on disposal, including when the root remains attached and never re-enables; a disposed guard inside a future callback does not release those registrations. A root-listener disposer also invokes its listener with `null`, so cleanup must tolerate reentry.

Verify the native caret and type through `page.keyboard.type()` without refocusing in [queue-recall-focus.e2e.ts](../../../apps/web/tests/queue-recall-focus.e2e.ts). jsdom editor-command tests alone cannot establish DOM caret placement. Recheck this ordering against the installed Lexical implementation when its version changes.

A queue recall retains its original Session while the Host reply is pending. If that Session's view unmounts, keep the initiating draft writer available to the operation and save the recalled draft before acknowledging recovery and releasing the Session. Verify switching away during the request, returning, and reloading; the other Session's draft and the remaining queue must stay intact.

## Overlays and menus

Compare related controls, including small selection controls, at actual size in affected themes/states and relevant long-label/narrow layouts. Static checks reject unsupported declarations; rendered comparison judges fit. Consult [geometry cases](../../../docs/ui-design-review-cases.md#geometry) when needed. Apply to scoped changes, not bulk restyling.

## Interaction and feedback

### Feedback surfaces

Follow [error handling](../dsh-error-handling/SKILL.md#localized-actionable-visible-reports). Choose feedback by message lifetime:

## Conversation drag feedback

Sidebar conversation references use the main content and right panel as the receiving area, with a visible blue overlay and localized release hint; requiring a drop directly on the input card is too narrow. Insert into the current draft while preserving its selection, text, chips, attachments, and queued messages. Returning to the sidebar preserves its own reorder behavior, and a reference drop elsewhere does not commit a hovered reorder position. Clear feedback when the pointer leaves the receiving area, the drag ends or is cancelled, the window loses focus, or the receiving composer unmounts. Keep ordinary file intake separate.

Verify the invitation while a native browser drag is still held, then release on blank conversation space and on the right panel. Assert the resulting chip, retained draft and focus, sidebar order, and overlay removal. A unit `drop` event alone cannot verify the receiving area's size or visible guidance.

## Responsive layouts

- Transient success/failure uses the app-wide Toast, with state and rendering in a host that survives the reporting panel/tab, such as a `shell.overlay` entry. A deletion may close its source panel; a Toast owned by that panel would disappear with it. Do not toast pending states.
- Failed operations retain visible data; failed deletion keeps the row.
- Surface-owned failures use in-place notices: query failure with Retry or field validation. Keep a compact notice beside populated content; only empty panels center a full error state.
- Use short plain-language errors, preferably one sentence, without internal jargon except necessary diagnostic codes. Chinese notices of at most two sentences omit the trailing 句号（。）. Reserve space or overlay notices so neighbors do not shift.

### Loading states

Lists use skeletons; other page-level loads center a bare spinner. Keep one loading treatment per page/component, including concurrent regions. Add loading text only when context requires it.

### Overlays and menus

Before merge, verify every menu, popover and tooltip closes on outside click (and Escape when focusable), fits the viewport with an edge margin, and escapes ancestor clipping, containing blocks and neighbor coverage, using a portal to body when needed. Flip only into a side that fits; never oscillate when neither fits.

Use shared scrollbar styles and a small inset; bars must stay inside containers without being clipped by rounded corners or edges.

### Platform window adaptation

New headers/pages account for macOS and Windows chrome. Menu, Modal and overlay primitives consume `--dsh-frame-top-clearance`; fix local macOS insets with scoped `[data-platform='darwin']` overrides and stylesheet assertions, not global-variable changes. Review the total clearance + page inset.

## Check the rules together

Inspect the composition, then affected internal/cross-group relationships, distant peers and expanded content. Match both endpoints of axes; compare complete icon boxes before optical adjustments. Preserve popup/focus visibility, field feedback, narrow-layout actions and drafts. Check affected theme materials/platform backdrops. Full-interface claims cover all regions; fixtures/crops establish only what they render.

## Maintain one owner per rule

Update the owning section or reference within this skill; do not expose its design specialties as separate skills. Keep examples in the [case reference](../../../docs/ui-design-review-cases.md); AGENTS and PR workflows link here instead of duplicating rules.

Rule changes state applicability, decisions, exceptions and observable verification; update a distinguishing case and remove superseded statements elsewhere. Declare migration versus future-edit scope without implying existing UI conforms. Automate only mechanically decidable checks. Local review tools consume repository rules and retain source/rule revisions rather than maintaining another standards copy.

## Design review escalation

- A PR with extensive UI changes, or any clearly user-perceivable change to UI or interaction, must get a designer or product review. When no approver holds that role, suggest requesting one from the design/product reviewers (roster as of 2026-09: yx zhang, yifffan, zhangziya, gaokaige; update this list here when membership changes).
