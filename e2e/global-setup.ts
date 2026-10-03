import { ensureFixtureDependencies, FIXTURES } from './helpers/fixtures'

/** Installs each fixture's dependencies once, so every test can clone a ready-to-run project. */
export default function globalSetup() {
  for (const fixture of FIXTURES) ensureFixtureDependencies(fixture)
}
