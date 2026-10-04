// A shared library with its own `dev` script: Grat must not offer it as an app.
export const page = (app) => `<!doctype html><title>${app}</title><h1>Grat monorepo: ${app}</h1>`
