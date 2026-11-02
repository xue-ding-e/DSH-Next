/** One-use identities scoped to one mounted client; transfer text is never authority. */
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'

export class ReferenceTransfers<Value> {
  private current: { token: string; value: Value; consumed: boolean } | undefined
  constructor(private readonly mime: string) {}
  /** Return a local finish handle; browser drag events need not share DataTransfer objects. */
  start(value: Value, transfer: DataTransfer): () => boolean {
    const entry = { token: randomUUID(), value, consumed: false }
    this.current = entry
    transfer.setData(this.mime, entry.token)
    return () => {
      if (this.current !== entry) return false
      this.current = undefined
      return entry.consumed
    }
  }
  /** Dispose this owner's active transfer, independent of any source row. */
  end(): boolean {
    const consumed = this.current?.consumed ?? false
    this.current = undefined
    return consumed
  }
  take(transfer: DataTransfer): Value | undefined {
    const current = this.current
    if (current === undefined || current.consumed || transfer.getData(this.mime) !== current.token) return undefined
    current.consumed = true
    return current.value
  }
}
