/** Native window colors switch immediately; renderer colors follow in the same frame. */
const scheme = window.matchMedia('(prefers-color-scheme: dark)')
let frame = 0
scheme.addEventListener('change', () => {
  cancelAnimationFrame(frame)
  document.documentElement.classList.add('appearance-changing')
  frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(() => {
      document.documentElement.classList.remove('appearance-changing')
    })
  })
})
