import { Check, ChevronDown } from "lucide-preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import { useBackAction } from "./actionStack";

type Option = { value: string; label: string };

export function Combobox({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly Option[];
  onChange: (value: string) => void;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const highlighted = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const selected = options.find((option) => option.value === value);
  const filtered = options.filter((option) =>
    option.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  const index = Math.min(active, filtered.length - 1);
  const expand = () => {
    setQuery("");
    setActive(
      Math.max(
        0,
        options.findIndex((option) => option.value === value),
      ),
    );
    setOpen(true);
  };
  const choose = (option: Option) => {
    setOpen(false);
    input.current?.blur();
    onChange(option.value);
  };

  useBackAction(`combobox:${id}`, () => setOpen(false), open);
  useEffect(() => {
    if (!open) return;
    const document = root.current?.ownerDocument;
    const outside = (event: PointerEvent) => {
      if (root.current && !event.composedPath().includes(root.current)) setOpen(false);
    };
    document?.addEventListener("pointerdown", outside);
    return () => document?.removeEventListener("pointerdown", outside);
  }, [open]);
  useEffect(() => {
    if (open) highlighted.current?.scrollIntoView({ block: "nearest" });
  }, [open, index, query]);

  return (
    <div
      class="combobox"
      ref={root}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <label class="combobox-label" for={`${id}-input`}>
        {label}
      </label>
      <div class={`combobox-control${open ? " open" : ""}`}>
        <input
          ref={input}
          id={`${id}-input`}
          role="combobox"
          aria-expanded={open}
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={open && index >= 0 ? `${id}-option-${index}` : undefined}
          value={open ? query : (selected?.label ?? "")}
          placeholder={
            open
              ? `Search ${label.toLocaleLowerCase()}…`
              : (selected?.label ?? `Select ${label.toLocaleLowerCase()}`)
          }
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellcheck={false}
          onFocus={expand}
          onClick={() => {
            if (!open) expand();
          }}
          onInput={(event) => {
            setQuery(event.currentTarget.value);
            setActive(0);
            setOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              if (!open) expand();
              else if (filtered.length)
                setActive(
                  (index + (event.key === "ArrowDown" ? 1 : -1) + filtered.length) %
                    filtered.length,
                );
            } else if (event.key === "Enter") {
              event.preventDefault();
              if (!open) expand();
              else if (filtered[index]) choose(filtered[index]);
            } else if (event.key === "Escape" && open) {
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
            } else if (event.key === "Tab") setOpen(false);
          }}
        />
        <button
          type="button"
          tabIndex={-1}
          aria-label={`${open ? "Close" : "Open"} ${label.toLocaleLowerCase()} options`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (open) setOpen(false);
            else {
              input.current?.focus();
              expand();
            }
          }}
        >
          <ChevronDown size={18} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
      {open && (
        <div class="combobox-list" id={`${id}-list`} role="listbox" aria-label={label}>
          {filtered.map((option, position) => (
            <button
              type="button"
              role="option"
              id={`${id}-option-${position}`}
              key={option.value}
              ref={position === index ? highlighted : undefined}
              tabIndex={-1}
              aria-selected={option.value === value}
              class={position === index ? "highlighted" : ""}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(option)}
            >
              <span>{option.label}</span>
              {option.value === value && <Check size={16} strokeWidth={2} aria-hidden="true" />}
            </button>
          ))}
          {!filtered.length && <p role="status">No matching options</p>}
        </div>
      )}
    </div>
  );
}
