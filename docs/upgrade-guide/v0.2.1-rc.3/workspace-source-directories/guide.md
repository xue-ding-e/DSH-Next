---
kind: upgrade-guide
description: "Workspace implementations must expose source directories and an atomic configuration operation."
---

# Workspace source directories

English | [中文](guide.zh.md)

## Change

The exported `Workspace` interface requires `sourcePaths`, `primaryPath`, and `configure(title, sourcePaths?)`. Code implementing this interface must provide them. `path` remains the original canonical registration directory; it can differ from the primary directory used for new Sessions. Existing Sessions retain their working directories and account membership when a secondary source is removed.

The Workspace Remote projection optionally includes `sourcePaths`; omission means `[path]`. The `workspace.rename` request accepts an optional ordered list and saves it together with the title. Existing single-directory records require no conversion.

With the Workspace registry mounted, `workspace-write` now authorizes writes to all current sources of the Session's owning Workspace, merged with deployment `additionalWritableRoots`. Previously, selecting sources did not add write permissions. Saved source edits affect the next operation. Removed sources and registry unload withdraw derived grants; explicit deployment grants remain. Each existing Session keeps its immutable original cwd as its workspace root. Historical sources retained for Session membership do not grant extra writes. `read-only` remains nonwritable, and `danger-full-access` remains unrestricted.

## Migration

1. Update custom `Workspace` implementations to expose their ordered source directories and first directory as `primaryPath`. Implement `configure` so invalid sources or a failed write preserve both the title and directory list. Preserve the original `path`.
2. Use `primaryPath`, or `sourcePaths?.[0] ?? path` for a Remote projection, when choosing the directory for a new Session. Continue using `path` for original registration identity and hierarchy.
3. Review every configured source as a write authorization under `workspace-write`. Remove directories that should not be writable, or select `read-only`. Keep deployment `additionalWritableRoots` only for grants that must remain after source removal or registry unload.
4. Verify that saving sources survives a reload, a new Session uses the chosen primary directory, and existing Session logs remain unchanged. Confirm that a configured sibling source accepts writes under `workspace-write`, an unlisted sibling is denied, and `read-only` denies writes to every source.
