// Files that may hold secrets: never copied into checkpoints.

const SAFE_ENV_FILE = /^(?:\.env|\.dev\.vars)(?:\..+)?\.(?:example|sample|template)$/i
const SECRET_FILES = [
  /^\.env(\..*)?$/i,
  /^\.envrc$/i,
  /^\.dev\.vars(\..*)?$/i,
  /^.+\.env$/i,
  /\.(pem|key|p8|p12|pfx|jks|keystore|ppk)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /^\.(npmrc|netrc|pypirc|git-credentials|yarnrc\.yml|pgpass)$/i,
  /^credentials(\.(json|ya?ml|toml|ini))?$/i,
  // Config-style only: `secrets.ts` is usually code the agent edited.
  /^secrets\.(json|ya?ml|toml|ini|env|txt)$/i,
  /\.(tfvars(\.json)?|tfstate(\.backup)?)$/i,
  /^serviceAccountKey.*\.json$/i,
  /firebase-adminsdk.*\.json$/i,
  /^client_secret.*\.json$/i,
]
/** Folders (a path, for gcloud) where everything is a credential or key. */
const SECRET_DIRS = ['.ssh', '.aws', '.gnupg', '.kube', '.docker', '.config/gcloud']

/** Whether a changed file may hold secrets (`.env.local`, keys, credentials). */
export function mayHoldSecrets(path: string): boolean {
  const parts = path.split('/')
  const name = parts.at(-1) ?? ''
  const dirs = `/${parts.slice(0, -1).join('/').toLowerCase()}/`
  if (SECRET_DIRS.some((dir) => dirs.includes(`/${dir}/`))) return true
  if (SAFE_ENV_FILE.test(name)) return false
  return SECRET_FILES.some((pattern) => pattern.test(name))
}
