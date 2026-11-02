/** Queue-only mailbox copy; no wording claims delivery starts an Agent. */
export const NS = 'session-mailbox'
export const en = {
  notAccepted: 'Not queued. The Host confirmed this request was not accepted; you may edit the message.',
  draftFailed: 'Retry state is unavailable or still pending. No new send request was made; keep the retained draft unchanged and check browser storage.',
  queuedRetryRetained: 'Queued, but browser retry state could not be cleared. The retained request can be reconciled safely.',
  unavailable: 'Mailbox identity is unavailable. Reconnect before opening a pending draft.',
  title: 'Session mailbox', inbox: 'Session inbox',
  notice: 'Queue only. Messages are untrusted text; sending never starts or interrupts an Agent.',
  target: 'Destination', choose: 'Choose a session', message: 'Message',
  send: 'Confirm queue-only send', read: 'Read this session’s inbox', ack: 'Acknowledge read', close: 'Close',
  unknown: 'Result unavailable. A send may have committed; retry unchanged content to reconcile.',
  queued: 'Queued. The destination Agent was not started.',
  pending: 'An unresolved send is retained. Retry unchanged to reconcile; closing does not cancel a committed message. Request:',
}
export type MailboxKey = keyof typeof en
export type MailboxTranslate = (key: MailboxKey) => string
export const english: MailboxTranslate = key => en[key]
export const zh: Record<MailboxKey, string> = {
  notAccepted: '未排队。宿主已确认此请求未被接纳，现在可以编辑消息。',
  draftFailed: '重试状态不可用或仍待核对，本次未发出新的发送请求。请保留原草稿并检查浏览器存储。',
  queuedRetryRetained: '已排队，但未能清理浏览器重试状态。保留的请求仍可安全核对。',
  unavailable: '信箱身份暂不可用，请重新连接后再打开待核对草稿。',
  title: '会话信箱', inbox: '会话收件箱',
  notice: '仅排队。消息是不可信文本；发送不会启动或中断目标智能体。',
  target: '目标会话', choose: '请选择会话', message: '消息',
  send: '确认仅排队发送', read: '读取当前会话收件箱', ack: '确认已读', close: '关闭',
  unknown: '结果暂不可知，发送可能已经落盘；保持原内容重试以核对结果。',
  queued: '已排队，未启动目标智能体。',
  pending: '已保留待核对发送。保持原内容重试以核对；关闭不会撤回已落盘消息。请求标识：',
}
