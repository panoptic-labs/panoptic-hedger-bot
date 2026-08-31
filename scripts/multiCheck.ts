import { checkMultiInstanceDirectory } from './lib/multiInstance'

function usage(): never {
  throw new Error('usage: pnpm multi:check -- <ops-directory>')
}

function main(): void {
  const args = process.argv.slice(2)
  if (args.length !== 1 || !args[0]) usage()
  const result = checkMultiInstanceDirectory(args[0])

  console.log(`image ${result.sourceSha}`)
  for (const instance of result.instances) {
    console.log(
      `${instance.name} signer=${instance.signerAddress} chain=${instance.chainId} ` +
        `safe=${instance.safeAddress} pool=${instance.poolAddress} mode=${instance.mode}`,
    )
  }
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : 'multi-instance validation failed')
  process.exitCode = 1
}
