/** Workspace name, source-folder, and removal dialogs keyed by their captured request. */
import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { Button, IconFolderOpenRegular, IconPlusOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { workspaceLabel } from '../tree.ts'
import type { WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { DirectoryFlowOwnerProps, WorkspaceActionRequest, WorkspaceBrowserProps } from '../contract/slots.ts'
import css from './WorkspaceBrowser.module.css'

type Props = Pick<WorkspaceBrowserProps, 'renameWorkspace' | 'deleteWorkspace' | 'settleWorkspaceAction' | 'renderSlot' | 't'> & {
  request: WorkspaceActionRequest
  workspaces: readonly WorkspaceView[]
}

/** @param props - captured request, current Workspace list, and existing mutations. @returns the active dialog. */
export function WorkspaceDialogs({ request, workspaces, renameWorkspace, deleteWorkspace, settleWorkspaceAction, renderSlot, t }: Props) {
  const composingRef = useRef(false)
  const renameTarget = request.action === 'rename' ? request : null
  const [renameDraft, setRenameDraft] = useState(request.displayTitle)
  const [renaming, setRenaming] = useState(false)
  const [renameError, setRenameError] = useState<string | null>(null)
  const editedWorkspace = workspaces.find(workspace => workspace.workspaceId === request.workspaceId)
  const originalSourceFolders = editedWorkspace?.sourcePaths ?? (editedWorkspace === undefined ? [] : [editedWorkspace.path])
  const [editSourceFolders, setEditSourceFolders] = useState<readonly string[]>(originalSourceFolders)
  const [sourceFolderFlowOpen, setSourceFolderFlowOpen] = useState(false)
  const [sourceFolderError, setSourceFolderError] = useState<string | null>(null)
  const sourceFoldersChanged = editSourceFolders.length !== originalSourceFolders.length
    || editSourceFolders.some((path, index) => path !== originalSourceFolders[index])
  const renameTrimmed = renameDraft.trim()
  // Self is excluded by identity, not by title: the draft is seeded with the
  // localized label, which for an automatically titled Workspace equals its
  // own displayed title without being a conflict with itself.
  const renameDuplicate = renameTarget !== null && renameTrimmed !== ''
    && workspaces.some(w => w.workspaceId !== renameTarget.workspaceId && w.title === renameTrimmed)
  const renameBlocked = renaming || renameTrimmed === ''
    || renameTarget === null || (renameTrimmed === renameTarget.storedTitle && !sourceFoldersChanged) || renameDuplicate
  const closeRename = () => {
    if (renaming) return
    settleWorkspaceAction()
    setRenameError(null)
  }
  const confirmRename = () => {
    if (renameBlocked) return
    setRenaming(true)
    setRenameError(null)
    const rename = sourceFoldersChanged
      ? renameWorkspace(renameTarget.workspaceId, renameTrimmed, editSourceFolders)
      : renameWorkspace(renameTarget.workspaceId, renameTrimmed)
    rename.then(() => {
      setRenaming(false)
      settleWorkspaceAction()
    }).catch((reason: unknown) => {
      setRenaming(false)
      setRenameError(reason instanceof Error ? reason.message : String(reason))
    })
  }

  const sourceFolderFlowOwner: DirectoryFlowOwnerProps = {
    open: sourceFolderFlowOpen,
    busy: renaming,
    onPicked: (path) => {
      if (editSourceFolders.includes(path)) {
        setSourceFolderError(t('workspace.sources.duplicate'))
        setSourceFolderFlowOpen(false)
        return
      }
      setEditSourceFolders(current => [...current, path])
      setSourceFolderError(null)
      setSourceFolderFlowOpen(false)
    },
    onCancel: () => { setSourceFolderFlowOpen(false) },
    onError: (message) => {
      setSourceFolderFlowOpen(false)
      setSourceFolderError(message)
    },
  }

  const deleteTarget = request.action === 'delete' ? request : null
  const [deleting, setDeleting] = useState(false)
  const [deleteCommittedId, setDeleteCommittedId] = useState<WorkspaceId | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  useEffect(() => {
    if (deleteCommittedId === null
      || workspaces.some(workspace => workspace.workspaceId === deleteCommittedId)) return
    setDeleting(false)
    setDeleteCommittedId(null)
    settleWorkspaceAction()
  }, [deleteCommittedId, workspaces, settleWorkspaceAction])
  const closeDelete = () => {
    if (deleting) return
    settleWorkspaceAction()
    setDeleteError(null)
  }
  const confirmDelete = () => {
    /* v8 ignore next -- the Modal is absent without a target and its button is disabled while deleting. */
    if (deleting || deleteTarget === null) return
    setDeleting(true)
    setDeleteCommittedId(null)
    setDeleteError(null)
    deleteWorkspace(deleteTarget.workspaceId).then(() => {
      // Keep the confirmation pending until this component has rendered the
      // committed list projection without the deleted id. Closing earlier
      // exposes one stale React frame to the next Create Workspace gesture.
      setDeleteCommittedId(deleteTarget.workspaceId)
    }).catch((reason: unknown) => {
      setDeleting(false)
      setDeleteError(reason instanceof Error ? reason.message : String(reason))
    })
  }

  return <>
    {renderSlot('sidebar.workspaces.directoryFlow', sourceFolderFlowOwner)}
    <Modal
      open={renameTarget !== null}
      className={clsx(css.workspaceEditor)}
      onClose={closeRename}
      closeLabel={t('close')}
      title={t('workspace.edit')}
      footer={(
        <>
          <Button variant="outline" disabled={renaming} onClick={closeRename}>{t('cancel')}</Button>
          <Button variant="primary" disabled={renameBlocked} onClick={confirmRename}>{t('save')}</Button>
        </>
      )}
    >
      <input
        className={css.renameInput}
        value={renameDraft}
        aria-label={t('field.workspaceName')}
        data-modal-autofocus
        disabled={renaming}
        onFocus={(e) => { e.target.select() }}
        onChange={(e) => { setRenameDraft(e.target.value); setRenameError(null) }}
        onCompositionStart={() => { composingRef.current = true }}
        onCompositionEnd={() => { composingRef.current = false }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !composingRef.current) {
            e.preventDefault()
            confirmRename()
          }
        }}
      />
      <div className={css.sourceFolders}>
        <div className={css.sourceFoldersTitle}>{t('workspace.sources.title')}</div>
        {editSourceFolders.map((path, index) => (
          <div className={css.sourceFolderRow} key={path}>
            <IconFolderOpenRegular size={14} />
            <span title={path}>{workspaceLabel(path)}</span>
            {index === 0 ? <span className={css.primarySource}>{t('workspace.sources.primary')}</span> : (
              <Button size="sm" disabled={renaming} onClick={() => {
                setEditSourceFolders(current => [path, ...current.filter(value => value !== path)])
              }}>{t('workspace.sources.makePrimary')}</Button>
            )}
            {editSourceFolders.length > 1 && (
              <button
                type="button"
                className={css.sourceFolderRemove}
                aria-label={t('workspace.sources.remove')}
                disabled={renaming}
                onClick={() => { setEditSourceFolders(current => current.filter((_, itemIndex) => itemIndex !== index)) }}
              >
                ×
              </button>
            )}
          </div>
        ))}
        <Button
          variant="outline"
          disabled={renaming || sourceFolderFlowOpen}
          onClick={() => { setSourceFolderError(null); setSourceFolderFlowOpen(true) }}
        >
          <IconPlusOutlineRegular size={14} />
          {t('workspace.sources.add')}
        </Button>
        {sourceFolderError !== null && <div className={css.renameError} role="alert">{sourceFolderError}</div>}
      </div>
      {renameDuplicate && (
        <div className={css.renameError} role="alert">{t('conflict.named', { name: renameTrimmed })}</div>
      )}
      {renameError !== null && <div className={css.renameError} role="alert">{renameError}</div>}
    </Modal>

    <Modal
      open={deleteTarget !== null}
      onClose={closeDelete}
      closeLabel={t('close')}
      title={t('delete.workspace')}
      {...deleteTarget === null
        ? {}
        : { description: t('delete.desc', { name: deleteTarget.displayTitle }) }}
      footer={(
        <>
          <Button variant="outline" disabled={deleting} onClick={closeDelete}>{t('cancel')}</Button>
          <Button
            variant="outline"
            className={css.deleteAction}
            disabled={deleting}
            onClick={confirmDelete}
          >
            {t('delete.workspace')}
          </Button>
        </>
      )}
    >
      {deleting && <div className={css.deleteStatus} role="status">{t('delete.pending')}</div>}
      {deleteError !== null && <div className={css.renameError} role="alert">{deleteError}</div>}
    </Modal>
  </>
}
