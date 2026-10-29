import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/** Only the explicitly sealed diagnosis can run; package qualification is never an accepted mode. */
export function assertDiagnosticMode(manifest, mode) {
  assert.equal(manifest.diagnosticOnly, true)
  assert(['install-dependencies', 'diagnose'].includes(mode), 'Packaging or qualification mode is not authorized')
}

/** Passing tests or an unreproduced leak still cannot become package qualification. */
export function assertDiagnosticResult(record) {
  assert.equal(record.diagnosticOnly, true)
  assert.equal(record.qualified, false)
  assert.deepEqual(record.packages, [])
  assert(Array.isArray(record.stages) && record.stages.length <= 1)
  for (const stage of record.stages) assert.equal(stage.label, 'desktop-tests')
}
if (import.meta.main) {
  const [action, path, mode] = process.argv.slice(2)
  const value = JSON.parse(readFileSync(path))
  if (action === 'mode') assertDiagnosticMode(value, mode)
  else if (action === 'result') assertDiagnosticResult(value)
  else throw new Error('Unknown diagnostic policy action')
}
