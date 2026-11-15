import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function ProjectMarkdown({ children }: { children: string }) {
  return <div className="text-sm leading-7 wrap-anywhere text-zinc-200 [&_h1]:mb-4 [&_h1]:mt-7 [&_h1]:text-2xl [&_h1]:font-semibold [&_h2]:mb-3 [&_h2]:mt-6 [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:mb-2 [&_h3]:mt-5 [&_h3]:text-lg [&_h3]:font-semibold [&_p]:my-3 [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:my-1 [&_blockquote]:my-4 [&_blockquote]:border-l-2 [&_blockquote]:border-line [&_blockquote]:pl-4 [&_blockquote]:text-muted [&_hr]:my-6 [&_hr]:border-line [&_pre]:my-4 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-black [&_pre]:p-4 [&_code]:font-mono [&_code]:text-[13px] [&_a]:underline [&_a]:underline-offset-4 [&_table]:w-full [&_th]:border [&_th]:border-line [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_td]:border [&_td]:border-line [&_td]:px-3 [&_td]:py-2 [&_input]:accent-white [&_strong]:font-semibold [&_strong]:text-white [&>:first-child]:mt-0 [&>:last-child]:mb-0">
    <Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
      a: ({ node: _node, children: label, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer">{label}</a>,
      table: ({ children: cells }) => <div className="my-4 overflow-x-auto"><table>{cells}</table></div>,
      img: ({ alt }) => <span className="text-muted">{alt ? `[이미지: ${alt}]` : '[이미지]'}</span>,
    }}>{children}</Markdown>
  </div>;
}
