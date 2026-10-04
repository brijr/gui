// A shared library with its own `dev` script: Gui must not offer it as an app.
export const page = (app) => `<!doctype html><title>${app}</title><h1>Gui monorepo: ${app}</h1>`
