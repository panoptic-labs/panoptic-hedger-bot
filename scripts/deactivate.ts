import { clearActivation } from '../src/runtime/activation'
import { writeDeactivation } from '../src/runtime/deactivation'
import { sanitizeError } from '../src/utils/sanitize'

function main(): void {
  // Write the live-process kill switch first. If this fails, retain activation
  // and report failure instead of claiming a partial deactivation succeeded.
  writeDeactivation()
  clearActivation()
  console.log(
    '✓ Emergency deactivation is active. Running processes will reject every later send; ' +
      'activation was removed, so the next start is dry-run. Run `pnpm status` to verify.',
  )
}

try {
  main()
} catch (error) {
  console.error(sanitizeError(error))
  process.exitCode = 1
}
