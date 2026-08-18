export type ExactEditResult = { text: string; replacements: number };

export function applyExactEdit(
	text: string,
	oldString: string,
	newString: string,
	replaceAll = false,
): ExactEditResult {
	if (!oldString) throw new Error("old_string cannot be empty.");
	const matches = countOccurrences(text, oldString);
	if (matches === 0) throw new Error("No exact match found.");
	if (!replaceAll && matches !== 1) {
		throw new Error(`Expected one exact match, found ${matches}. Use replace_all only when intentional.`);
	}
	return {
		text: replaceAll ? text.split(oldString).join(newString) : text.replace(oldString, newString),
		replacements: replaceAll ? matches : 1,
	};
}

function countOccurrences(text: string, search: string): number {
	let count = 0;
	let cursor = 0;
	while ((cursor = text.indexOf(search, cursor)) >= 0) {
		count += 1;
		cursor += search.length;
	}
	return count;
}

