import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

const plugins = [remarkGfm]

/** Load the synchronous parser only when a completed message needs it. */
export default function SmallMarkdown({
  text,
  components,
}: {
  text: string
  components: Components
}) {
  return (
    <ReactMarkdown remarkPlugins={plugins} components={components}>
      {text}
    </ReactMarkdown>
  )
}
