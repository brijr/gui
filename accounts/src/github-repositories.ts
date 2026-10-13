import type { GitHubRepository } from '../../src/shared/github'

export interface ConnectedRepository extends GitHubRepository {
  installationId: number
}

type ReadGitHub = <T>(token: string, path: string) => Promise<T>
interface RepositoryPage {
  repositories: { id: number; full_name: string; private: boolean }[]
}

const CONCURRENCY = 4
const HINT_TTL_MS = 10 * 60_000
const MAX_ACCOUNTS = 32
const MAX_HINTS = 5000

/** Discovery hints narrow a fresh access check; they never authorize a mutation. */
export class GitHubRepositories {
  private hints = new Map<string, { until: number; repositories: Map<number, number> }>()

  constructor(
    private readonly read: ReadGitHub,
    private readonly missing: (error: unknown) => boolean = () => false,
  ) {}

  async list(token: string, account: string): Promise<ConnectedRepository[]> {
    const output: ConnectedRepository[] = []
    for (let page = 1; ; page++) {
      const { installations } = await this.read<{ installations: { id: number }[] }>(
        token,
        `/user/installations?per_page=100&page=${page}`,
      )
      const batches: ConnectedRepository[][] = Array.from(
        { length: installations.length },
        () => [],
      )
      let next = 0
      let failure: unknown
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, installations.length) }, async () => {
          while (next < installations.length && failure === undefined) {
            const index = next++
            try {
              batches[index] = await this.inInstallation(token, installations[index].id)
            } catch (error) {
              failure = error
            }
          }
        }),
      )
      // Wait for in-flight requests before rejecting, so failures cannot leave discovery running.
      if (failure !== undefined) throw failure
      for (const batch of batches) output.push(...batch)
      if (installations.length < 100) break
    }
    const repositories = [...new Map(output.map((repo) => [repo.id, repo])).values()].sort((a, b) =>
      a.fullName.localeCompare(b.fullName),
    )
    this.remember(account, repositories)
    return repositories
  }

  async find(token: string, account: string, id: number): Promise<ConnectedRepository | null> {
    const hints = this.hints.get(account)
    const installation = hints && hints.until > Date.now() ? hints.repositories.get(id) : undefined
    if (installation !== undefined) {
      // This endpoint filters by the current user's AND app's access on every request.
      const fresh = (await this.inInstallation(token, installation, id)).find(
        (repo) => repo.id === id,
      )
      if (fresh) return fresh
      hints?.repositories.delete(id)
    }
    // A missing/moved installation, new process, or expired hint falls back to fresh discovery.
    return (await this.list(token, account)).find((repo) => repo.id === id) ?? null
  }

  private async inInstallation(token: string, installation: number, target?: number) {
    const output: ConnectedRepository[] = []
    for (let page = 1; ; page++) {
      let result: RepositoryPage
      try {
        result = await this.read<RepositoryPage>(
          token,
          `/user/installations/${installation}/repositories?per_page=100&page=${page}`,
        )
      } catch (error) {
        if (this.missing(error)) return []
        throw error
      }
      output.push(
        ...result.repositories.map((repo) => ({
          id: repo.id,
          fullName: repo.full_name,
          private: repo.private,
          installationId: installation,
        })),
      )
      if (target !== undefined && output.some((repo) => repo.id === target)) break
      if (result.repositories.length < 100) break
    }
    return output
  }

  private remember(account: string, repositories: ConnectedRepository[]) {
    const now = Date.now()
    for (const [key, entry] of this.hints) if (entry.until <= now) this.hints.delete(key)
    this.hints.delete(account)
    this.hints.set(account, {
      until: now + HINT_TTL_MS,
      repositories: new Map(
        repositories.slice(0, MAX_HINTS).map((repo) => [repo.id, repo.installationId]),
      ),
    })
    while (this.hints.size > MAX_ACCOUNTS) {
      const oldest = this.hints.keys().next().value
      if (oldest !== undefined) this.hints.delete(oldest)
    }
  }
}
