/** Queue-only mailbox copy; no wording claims delivery starts an Agent. */
export const NS = 'session-mailbox'
/** English mailbox copy. */
export const en = {
  notAccepted: 'Not queued. The Host confirmed this request was not accepted; you may edit the message.',
  draftFailed: 'Retry state is unavailable or still pending. No new send request was made; keep the retained draft unchanged and check browser storage.',
  queuedRetryRetained: 'Queued, but browser retry state could not be cleared. The retained request can be reconciled safely.',
  unavailable: 'Mailbox identity is unavailable. Reconnect before opening a pending draft.',
  title: 'Session mailbox', inbox: 'Session inbox',
  notice: 'Messages go to the destination inbox without starting or interrupting the conversation.',
  target: 'Destination', choose: 'Choose a session', message: 'Message',
  send: 'Send to mailbox', read: 'Read inbox', ack: 'Mark as read', close: 'Close',
  reconcile: 'Check send status', refresh: 'Refresh',
  requestId: 'Request ID', noTargets: 'Create another conversation to send it a message.',
  messagePlaceholder: 'Write a message for the selected conversation',
  inboxHint: 'Read messages sent to this conversation.',
  emptyInbox: 'No messages in this inbox',
  inboxFailed: 'Could not update the inbox. Refresh to try again.',
  receiptQueued: 'Unread', receiptAcknowledged: 'Read', receiptCancelled: 'Cancelled',
  unknown: 'Result unavailable. A send may have committed; retry unchanged content to reconcile.',
  queued: 'Queued. The destination Agent was not started.',
  pending: 'This send is awaiting confirmation. Check its status before editing. Closing keeps the pending message.',
}
/** Keys shared by every mailbox dictionary. */
export type MailboxKey = keyof typeof en
/** Lookup for mailbox labels and notices. */
export type MailboxTranslate = (key: MailboxKey) => string
/**
 * English lookup for standalone rendering.
 * @param key - mailbox dictionary key.
 * @returns its English label or notice.
 */
export const english: MailboxTranslate = key => en[key]
/** Chinese mailbox copy. */
export const zh: Record<MailboxKey, string> = {
  notAccepted: '未排队。宿主已确认此请求未被接纳，现在可以编辑消息。',
  draftFailed: '重试状态不可用或仍待核对，本次未发出新的发送请求。请保留原草稿并检查浏览器存储。',
  queuedRetryRetained: '已排队，但未能清理浏览器重试状态。保留的请求仍可安全核对。',
  unavailable: '信箱身份暂不可用，请重新连接后再打开待核对草稿。',
  title: '会话信箱', inbox: '会话收件箱',
  notice: '消息仅加入目标会话的收件箱，不会启动或打断对话',
  target: '目标会话', choose: '请选择会话', message: '消息',
  send: '发送到信箱', read: '读取收件箱', ack: '标为已读', close: '关闭',
  reconcile: '核对发送结果', refresh: '刷新',
  requestId: '请求标识', noTargets: '创建另一个会话后，即可向它发送消息',
  messagePlaceholder: '输入要发送给目标会话的消息',
  inboxHint: '读取发送给当前会话的消息',
  emptyInbox: '收件箱暂无消息',
  inboxFailed: '更新收件箱失败，请点击刷新重试',
  receiptQueued: '未读', receiptAcknowledged: '已读', receiptCancelled: '已取消',
  unknown: '结果暂不可知，发送可能已经落盘；保持原内容重试以核对结果。',
  queued: '已排队，未启动目标智能体。',
  pending: '这条消息的发送结果尚待确认，请先核对结果再编辑。关闭会保留待核对消息',
}
