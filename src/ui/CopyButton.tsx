import { Check, Copy } from "lucide-preact";
import { useEffect, useRef, useState } from "preact/hooks";

export function CopyButton({ getText, label = "Copy" }: { getText: () => string; label?: string }) {
	const [copied, setCopied] = useState(false);
	const timer = useRef<number | null>(null);
	useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);

	return (
		<button
			type="button"
			class={`copy-btn${copied ? " copied" : ""}`}
			aria-label={copied ? "Copied" : label}
			title={copied ? "Copied" : label}
			onClick={async (event) => {
				event.preventDefault();
				const text = getText().trim();
				if (!text) return;
				await copyText(text);
				setCopied(true);
				if (timer.current !== null) window.clearTimeout(timer.current);
				timer.current = window.setTimeout(() => setCopied(false), 1400);
			}}
		>
			{copied ? <Check size={15} strokeWidth={2.2} aria-hidden="true" /> : <Copy size={15} strokeWidth={2} aria-hidden="true" />}
		</button>
	);
}

export async function copyText(text: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(text);
	} catch {
		const area = document.createElement("textarea");
		area.value = text;
		document.body.appendChild(area);
		area.select();
		document.execCommand("copy");
		area.remove();
	}
}
