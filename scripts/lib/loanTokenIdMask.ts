/**
 * Migrated to `@panoptic-eng/sdk/zodiac` (packages/sdk/src/zodiac)
 * `src/tokenIdMask.ts`, generalized to strike/optionRatio field masks for the
 * new à-la-carte roles. This shim keeps the historical import path.
 */
export {
  isPureLoanTokenId,
  loanBitmaskCondition,
  loanWidthFieldsMask,
} from '@panoptic-eng/sdk/zodiac'
