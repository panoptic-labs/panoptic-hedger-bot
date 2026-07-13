/**
 * Bridges the viem `PublicClient`/`WalletClient` type-identity skew between this
 * app and the built SDK. The app and SDK can resolve different copies of
 * `abitype` (keyed by TypeScript version), so their `Client` types are nominally
 * "unrelated" even though structurally identical. This mirrors the same helper
 * used in apps/vault-managers.
 */
type SdkClientParam<T extends (...args: never[]) => unknown> = Parameters<T>[0] extends {
  client: infer Client
}
  ? Client
  : never

/** Cast a viem client to the client type a given SDK function expects. */
export function asSdkClient<T extends (...args: never[]) => unknown>(
  client: unknown,
): SdkClientParam<T> {
  return client as SdkClientParam<T>
}
