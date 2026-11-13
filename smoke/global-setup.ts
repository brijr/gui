import { ensureFixtureDependencies, FIXTURES } from '../e2e/helpers/fixtures'

/** Installs the vite fixture's dependencies once; the smoke test uses no other. */
export default function globalSetup() {
  for (const fixture of FIXTURES) if (fixture.name === 'vite') ensureFixtureDependencies(fixture)
}
