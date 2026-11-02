/** One-use identities scoped to one mounted client; transfer text is never authority. */
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'

export class ReferenceTransfers<Value> {
  private current: { token: string; value: Value } | undefined
  private consumed = false
  constructor(private readonly mime: string) {}
  start(value: Value, transfer: DataTransfer): void {
    this.consumed = false
    const token = randomUUID()
    this.current = { token, value }
    transfer.setData(this.mime, token)
  }
  end(): boolean {
    const consumed = this.consumed
    this.current = undefined
    this.consumed = false
    return consumed
  }
  take(transfer: DataTransfer): Value | undefined {
    const current = this.current
    if (current === undefined || transfer.getData(this.mime) !== current.token) return undefined
    this.current = undefined
    this.consumed = true
    return current.value
  }
}
