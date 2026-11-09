import { defaultIcons } from "agentic-ui-kit";
import { Button as AriaButton } from "react-aria-components";
import { DropdownMenu } from "./menu";

/** One choice of a {@link Select}. */
export interface Option<T extends string> {
  /** The value `onChange` gets. */
  id: T;
  /** What the user reads. */
  label: string;
  /** A muted line under the label in the list. */
  description?: string;
}

interface SelectProps<T extends string> {
  /** Name for screen readers and the menu. The select draws no label of its own. */
  label: string;
  /** The choices, in order. */
  options: readonly Option<T>[];
  /** The `id` of the chosen option. */
  value: T;
  /** Called with the `id` the user picked. */
  onChange: (value: T) => void;
  /** Grays the select out and ignores input. */
  disabled?: boolean;
  /** Extra classes for the wrapper, e.g. a width. */
  className?: string;
}

/** A dropdown: the value shows on the right with a caret, as in claude.ai's settings. */
export function Select<T extends string>({ label, options, value, onChange, disabled, className }: SelectProps<T>) {
  const current = options.find((option) => option.id === value);
  return (
    <div className={className ?? ""}>
      <DropdownMenu label={label} placement="bottom end" sheet={false} selected={value} onSelect={(id) => onChange(id as T)}
        items={options.map((option) => ({ id: option.id, label: option.label, ...(option.description && { description: option.description }) }))}
        trigger={
          <AriaButton aria-label={label} isDisabled={disabled ?? false} className="flex min-h-8 items-center gap-1.5 rounded-chat-sm px-2 text-sm text-chat-fg outline-none data-hovered:bg-chat-hover data-focus-visible:outline-2 data-focus-visible:outline-chat-focus data-disabled:opacity-50">
            <span className="truncate">{current ? current.label : value}</span>
            <span className="text-chat-muted [&_svg]:size-4">{defaultIcons.dropdown}</span>
          </AriaButton>
        } />
    </div>
  );
}
