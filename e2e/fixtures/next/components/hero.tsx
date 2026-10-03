'use client'

import { useState } from 'react'

export function Hero() {
  const [count, setCount] = useState(0)

  return (
    <section>
      <button type="button" data-testid="hero-btn" onClick={() => setCount((c) => c + 1)}>
        Clicked {count} times
      </button>
    </section>
  )
}
