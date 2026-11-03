import { expect, test } from 'bun:test'
import { GitHubRepositories } from './src/github-repositories'

test('installation discovery paginates with at most four concurrent repository requests', async () => {
  let active = 0
  let peak = 0
  const pages: string[] = []
  const discovery = new GitHubRepositories(async <T>(_token: string, path: string): Promise<T> => {
    pages.push(path)
    const url = new URL(path, 'https://api.github.com')
    if (url.pathname === '/user/installations') {
      const page = Number(url.searchParams.get('page'))
      return {
        installations:
          page === 1 ? Array.from({ length: 100 }, (_, i) => ({ id: i + 1 })) : [{ id: 101 }],
      } as T
    }
    const id = Number(url.pathname.split('/')[3])
    active++
    peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, 1))
    active--
    const page = Number(url.searchParams.get('page'))
    return {
      repositories:
        id === 1 && page === 1
          ? Array.from({ length: 100 }, (_, index) => ({
              id: index + 1,
              full_name: `first/repo-${index}`,
              private: true,
            }))
          : [{ id: id === 1 ? 1001 : id + 2000, full_name: `owner/repo-${id}`, private: true }],
    } as T
  })
  const result = await discovery.list('token', 'account')
  expect(result).toHaveLength(201)
  expect(peak).toBe(4)
  expect(active).toBe(0)
  expect(pages).toContain('/user/installations?per_page=100&page=2')
  expect(pages).toContain('/user/installations/1/repositories?per_page=100&page=2')
})

test('a discovery hint narrows requests but still checks current repository access', async () => {
  let permitted = true
  let fullName = 'owner/original'
  const paths: string[] = []
  const discovery = new GitHubRepositories(async <T>(_token: string, path: string): Promise<T> => {
    paths.push(path)
    if (path.startsWith('/user/installations?')) return { installations: [{ id: 11 }] } as T
    return { repositories: permitted ? [{ id: 1, full_name: fullName, private: true }] : [] } as T
  })
  await discovery.list('token', 'account')
  paths.length = 0
  fullName = 'owner/renamed'
  expect(await discovery.find('token', 'account', 1)).toMatchObject({ fullName })
  expect(paths).toEqual(['/user/installations/11/repositories?per_page=100&page=1'])
  permitted = false
  expect(await discovery.find('token', 'account', 1)).toBeNull()
})

test('hints never cross accounts and a removed installation falls back to fresh discovery', async () => {
  const paths: string[] = []
  let installation = 11
  const gone = new Error('Installation removed')
  const discovery = new GitHubRepositories(
    async <T>(_token: string, path: string): Promise<T> => {
      paths.push(path)
      if (path.startsWith('/user/installations?'))
        return { installations: [{ id: installation }] } as T
      if (!path.startsWith(`/user/installations/${installation}/`)) throw gone
      return { repositories: [{ id: 1, full_name: 'owner/repo', private: true }] } as T
    },
    (error) => error === gone,
  )
  await discovery.list('token', 'first')
  paths.length = 0
  expect(await discovery.find('token', 'second', 1)).toMatchObject({ id: 1 })
  expect(paths[0]).toBe('/user/installations?per_page=100&page=1')
  installation = 22
  expect(await discovery.find('new-token', 'first', 1)).toMatchObject({ installationId: 22 })
})

test('provider failures drain in-flight discovery and cannot become authorization hints', async () => {
  const refused = new Error('Provider unavailable')
  let active = 0
  let fail = true
  const discovery = new GitHubRepositories(async <T>(_token: string, path: string): Promise<T> => {
    if (path.startsWith('/user/installations?'))
      return { installations: [{ id: 11 }, { id: 22 }] } as T
    active++
    try {
      await new Promise((resolve) => setTimeout(resolve, 2))
      if (fail) throw refused
      return { repositories: [] } as T
    } finally {
      active--
    }
  })
  await expect(discovery.list('token', 'account')).rejects.toBe(refused)
  expect(active).toBe(0)
  fail = false
  expect(await discovery.find('token', 'account', 1)).toBeNull()
})

test('find proves the user can see a repository, not push to it', async () => {
  // A read-only member still finds the repository, so its credential must be read only.
  const discovery = new GitHubRepositories(async <T>(_token: string, path: string): Promise<T> => {
    if (path.startsWith('/user/installations?')) return { installations: [{ id: 11 }] } as T
    return {
      repositories: [
        {
          id: 1,
          full_name: 'org/repo',
          private: true,
          permissions: { admin: false, push: false, pull: true },
        },
      ],
    } as T
  })
  expect(await discovery.find('token', 'account', 1)).toEqual({
    id: 1,
    fullName: 'org/repo',
    private: true,
    installationId: 11,
  })
})
