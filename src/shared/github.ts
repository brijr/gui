export interface GitHubProfile {
  login: string
  name: string | null
  email: string | null
  updates: boolean
}

export interface GitHubRepository {
  id: number
  fullName: string
  private: boolean
}

export interface GitHubState {
  configured: boolean
  profile: GitHubProfile | null
  repositories: GitHubRepository[]
}

export interface GitHubLogin {
  code: string
  interval: number
  expiresAt: number
}

export type GitHubPoll = { pending: true } | { pending: false }
