/**
 * GitHub tokens Gui holds are not interchangeable. A user OAuth token reaches every connected
 * repository with the app's full permissions; a repo token is an installation token for one
 * repository, contents-read only, for about an hour.
 */

declare const userGitHubToken: unique symbol
declare const repoToken: unique symbol

/** The signed-in user's GitHub OAuth access token. Never pass this to git or as a repo credential. */
export type UserGitHubToken = string & { readonly [userGitHubToken]: never }
/** Installation token for one connected repository. What clone uses; it cannot push. */
export type RepoToken = string & { readonly [repoToken]: never }

export const asUserGitHubToken = (value: string) => value as UserGitHubToken
export const asRepoToken = (value: string) => value as RepoToken
