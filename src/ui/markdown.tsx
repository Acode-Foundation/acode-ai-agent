import { useMemo } from "preact/hooks";
import { renderMarkdown } from "./markdownRender";

export function Markdown({ text }: { text: string }) {
	const html = useMemo(() => renderMarkdown(text), [text]);
	return <div class="md" dangerouslySetInnerHTML={{ __html: html }} />;
}
