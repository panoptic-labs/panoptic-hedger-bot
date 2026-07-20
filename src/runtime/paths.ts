import path from 'node:path'

export function runtimeDataPath(filename: string): string {
  const stateDirectory = process.env.HEDGER_STATE_DIR
  return stateDirectory
    ? path.resolve(stateDirectory, filename)
    : path.resolve(process.cwd(), filename)
}
