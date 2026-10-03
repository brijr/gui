import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer" className="text-accent underline">
      {children}
    </a>
  ),
  // Never auto-load remote images from agent output: that's an exfiltration channel.
  img: ({ src, alt }) =>
    typeof src === 'string' && src ? (
      <a href={src} target="_blank" rel="noreferrer" className="text-accent underline">
        {alt || src}
      </a>
    ) : null,
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown break-words leading-relaxed">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
}
