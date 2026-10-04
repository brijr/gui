import { useState } from 'react'

export default function App() {
  const [count, setCount] = useState(0)

  return (
    <main>
      <h1>Gui Vite fixture</h1>
      <button type="button" className="counter" onClick={() => setCount((c) => c + 1)}>
        count is {count}
      </button>
    </main>
  )
}
