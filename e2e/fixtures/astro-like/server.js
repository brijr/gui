// Serves HTML the way Astro's dev server does: every element written in a .astro file
// carries that file's absolute path and the line:column of its opening tag. No
// dependencies, so nothing needs installing.
const hero = `${import.meta.dir}/src/components/Hero.astro`
const layout = `${import.meta.dir}/src/layouts/Layout.astro`
const at = (file, loc) => `data-astro-source-file="${file}" data-astro-source-loc="${loc}"`

// The label has no attributes of its own (see src/components/Hero.astro).
const html = `<!doctype html>
<html lang="en" ${at(layout, '5:1')}>
  <head><title>Gui Astro-like fixture</title></head>
  <body ${at(layout, '9:3')}>
    <main ${at(layout, '10:5')}>
      <section class="hero" ${at(hero, '9:1')}>
        <h1 ${at(hero, '10:3')}>Gui Astro-like fixture</h1>
        <div class="actions" ${at(hero, '11:3')}>
          <button type="button" class="cta" ${at(hero, '12:5')}><span class="label">Get started</span></button>
        </div>
      </section>
    </main>
  </body>
</html>`

const server = Bun.serve({
  port: 0,
  fetch: () => new Response(html, { headers: { 'content-type': 'text/html' } }),
})

console.log(`Local: ${server.url}`)
