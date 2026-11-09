// Text fields on react-aria-components, styled with the kit tokens. TextField, NumberField and TextArea share one look.
import { Input, Label, TextArea as AriaTextArea, TextField as AriaTextField } from "react-aria-components";

const field = "w-full rounded-chat-sm border border-chat-border bg-chat-surface px-2.5 py-1.5 text-sm text-chat-fg outline-none placeholder:text-chat-muted data-focused:border-chat-focus data-disabled:opacity-50";

interface TextProps {
  /** Name of the field. Shown above it with `showLabel`, otherwise only for screen readers. */
  label: string;
  /** Show the label above the field. Off when a SettingsRow already names it. */
  showLabel?: boolean;
  /** The current text. */
  value: string;
  /** Called with the new text on every keystroke. */
  onChange: (value: string) => void;
  /** The input type. `search` clears on Escape. */
  type?: "text" | "url" | "password" | "number" | "search";
  /** Hint shown while the field is empty. */
  placeholder?: string;
  /** Longest text the browser lets the user type. */
  maxLength?: number;
  /** Grays the field out and ignores input. */
  disabled?: boolean;
  /** Marks the field as required for forms and screen readers. */
  required?: boolean;
  /** Extra classes for the wrapper, e.g. a width. */
  className?: string;
  /** The browser's autofill hint, e.g. `off` for tokens. */
  autoComplete?: string;
}

/** A one-line text field. */
export function TextField({ label, showLabel, value, onChange, type = "text", placeholder, maxLength, disabled, required, className, autoComplete }: TextProps) {
  return (
    <AriaTextField aria-label={showLabel ? undefined : label} value={value} onChange={onChange} type={type} isDisabled={disabled ?? false} isRequired={required ?? false} className={`flex flex-col gap-1 ${className ?? ""}`}>
      {showLabel && <Label className="text-sm font-medium">{label}</Label>}
      <Input className={field} placeholder={placeholder} maxLength={maxLength} autoComplete={autoComplete}
        onKeyDown={type === "search" ? (event) => { if (event.key === "Escape" && value) { event.stopPropagation(); onChange(""); } } : undefined} />
    </AriaTextField>
  );
}

/** A whole-number box. It does not clamp while typing (typing 5000 with min 1000 passes 5); an empty or bad entry gives NaN, so callers check the range before saving. */
export function NumberField({ value, onChange, min: _min, max: _max, ...props }: Omit<TextProps, "value" | "onChange" | "type"> & {
  /** The number shown. NaN shows an empty box. */
  value: number;
  /** Called with the typed number, or NaN when the box is empty or not a number. */
  onChange: (value: number) => void;
  /** The smallest allowed value. For the caller's own check; the box does not enforce it. */
  min?: number;
  /** The largest allowed value. For the caller's own check; the box does not enforce it. */
  max?: number;
}) {
  return (
    <TextField {...props} type="number" value={Number.isFinite(value) ? String(value) : ""}
      onChange={(text) => onChange(text.trim() === "" ? Number.NaN : Number(text))}
      className={props.className ?? "w-28"} />
  );
}

/** A multi-line text field the user can resize vertically. */
export function TextArea({ label, showLabel, value, onChange, placeholder, maxLength, disabled, rows = 5, className }: Omit<TextProps, "type"> & {
  /** Visible lines before the user resizes it. */
  rows?: number;
}) {
  return (
    <AriaTextField aria-label={showLabel ? undefined : label} value={value} onChange={onChange} isDisabled={disabled ?? false} className={`flex flex-col gap-1 ${className ?? ""}`}>
      {showLabel && <Label className="text-sm font-medium">{label}</Label>}
      <AriaTextArea className={`${field} resize-y`} rows={rows} placeholder={placeholder} maxLength={maxLength} />
    </AriaTextField>
  );
}
