// Assistant prose as Markdown. Raw HTML in the text is shown as text, never as markup, and images are not loaded;
// links keep the library's safe URL handling, so a `javascript:` link has no target, and open in another tab.
// Everything else from the server stays plain text.
import Markdown, { type Components } from 'react-markdown';

const COMPONENTS: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
};

export function Prose({ text }: { text: string }) {
  return (
    <div className="prose">
      <Markdown disallowedElements={['img']} unwrapDisallowed components={COMPONENTS}>
        {text}
      </Markdown>
    </div>
  );
}
