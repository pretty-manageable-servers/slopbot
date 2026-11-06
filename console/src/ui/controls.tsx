// Form controls the kit does not have (it is for chat parts): a switch, a select, text fields and a table. Built
// on react-aria-components, as the kit is, and styled only with the kit's tokens, so they follow its themes.
import { Popover, defaultIcons } from "agentic-ui-kit";
import type { ReactNode } from "react";
import {
  Button as AriaButton, Input, Label, ListBox, ListBoxItem, Select as AriaSelect, SelectValue,
  Switch as AriaSwitch, TextArea as AriaTextArea, TextField as AriaTextField,
} from "react-aria-components";

const field = "w-full rounded-chat-sm border border-chat-border bg-chat-surface px-2.5 py-1.5 text-sm text-chat-fg outline-none placeholder:text-chat-muted data-focused:border-chat-focus data-disabled:opacity-50";

/** An on/off switch. `label` is for screen readers when the row already shows the text. */
export function Switch({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (on: boolean) => void; disabled?: boolean }) {
  return (
    <AriaSwitch aria-label={label} isSelected={checked} onChange={onChange} isDisabled={disabled ?? false} className="group inline-flex shrink-0 cursor-pointer items-center data-disabled:cursor-default data-disabled:opacity-50">
      <span className="flex h-5 w-9 items-center rounded-full bg-chat-border-strong p-0.5 transition-colors group-data-selected:bg-chat-accent group-data-focus-visible:outline-2 group-data-focus-visible:outline-chat-focus">
        <span className="size-4 rounded-full bg-chat-fg shadow transition-transform group-data-selected:translate-x-4 group-data-selected:bg-chat-accent-fg" />
      </span>
    </AriaSwitch>
  );
}

export interface Option<T extends string> { id: T; label: string; description?: string }

/** A dropdown: the value shows on the right with a caret, as in claude.ai's settings. */
export function Select<T extends string>({ label, options, value, onChange, disabled, className }: {
  label: string; options: readonly Option<T>[]; value: T; onChange: (value: T) => void; disabled?: boolean; className?: string;
}) {
  return (
    <AriaSelect aria-label={label} selectedKey={value} onSelectionChange={(key) => key !== null && onChange(key as T)} isDisabled={disabled ?? false} className={className ?? ""}>
      <AriaButton className="flex min-h-8 items-center gap-1.5 rounded-chat-sm px-2 text-sm text-chat-fg outline-none data-hovered:bg-chat-hover data-focus-visible:outline-2 data-focus-visible:outline-chat-focus data-disabled:opacity-50">
        <SelectValue className="truncate" />
        <span className="text-chat-muted [&_svg]:size-4">{defaultIcons.dropdown}</span>
      </AriaButton>
      <Popover placement="bottom end">
        <ListBox className="max-h-80 min-w-44 overflow-auto p-1.5 outline-none">
          {options.map((option) => (
            <ListBoxItem key={option.id} id={option.id} textValue={option.label} className="group flex cursor-pointer items-center gap-2.5 rounded-chat-sm px-2 py-1 text-sm outline-none data-focused:bg-chat-popover-hover">
              <span className="flex min-w-0 flex-1 flex-col">
                <span>{option.label}</span>
                {option.description && <span className="text-xs text-chat-muted">{option.description}</span>}
              </span>
              <span className="invisible text-chat-check group-data-selected:visible [&_svg]:size-4">{defaultIcons.check}</span>
            </ListBoxItem>
          ))}
        </ListBox>
      </Popover>
    </AriaSelect>
  );
}

interface TextProps {
  label: string;
  /** Show the label above the field. Off when a SettingsRow already names it. */
  showLabel?: boolean;
  value: string; onChange: (value: string) => void;
  type?: "text" | "url" | "password" | "number" | "search";
  placeholder?: string; maxLength?: number; disabled?: boolean; required?: boolean; className?: string;
  autoComplete?: string;
}

export function TextField({ label, showLabel, value, onChange, type = "text", placeholder, maxLength, disabled, required, className, autoComplete }: TextProps) {
  return (
    <AriaTextField aria-label={showLabel ? undefined : label} value={value} onChange={onChange} type={type} isDisabled={disabled ?? false} isRequired={required ?? false} className={`flex flex-col gap-1 ${className ?? ""}`}>
      {showLabel && <Label className="text-sm font-medium">{label}</Label>}
      <Input className={field} placeholder={placeholder} maxLength={maxLength} autoComplete={autoComplete} />
    </AriaTextField>
  );
}

/** A whole-number field. An empty or bad entry gives NaN; check it before saving. */
export function NumberField({ value, onChange, min, max, ...props }: Omit<TextProps, "value" | "onChange" | "type"> & { value: number; onChange: (value: number) => void; min?: number; max?: number }) {
  return (
    <TextField {...props} type="number" value={Number.isFinite(value) ? String(value) : ""}
      onChange={(text) => onChange(text.trim() === "" ? Number.NaN : Math.min(max ?? Infinity, Math.max(min ?? -Infinity, Number(text))))}
      className={props.className ?? "w-28"} />
  );
}

export function TextArea({ label, showLabel, value, onChange, placeholder, maxLength, disabled, rows = 5, className }: Omit<TextProps, "type"> & { rows?: number }) {
  return (
    <AriaTextField aria-label={showLabel ? undefined : label} value={value} onChange={onChange} isDisabled={disabled ?? false} className={`flex flex-col gap-1 ${className ?? ""}`}>
      {showLabel && <Label className="text-sm font-medium">{label}</Label>}
      <AriaTextArea className={`${field} resize-y`} rows={rows} placeholder={placeholder} maxLength={maxLength} />
    </AriaTextField>
  );
}

export interface Column<Row> { id: string; label: string; cell: (row: Row) => ReactNode; align?: "left" | "right"; className?: string }

/** A plain table as in claude.ai's connector list: muted headers, a divider under each row. */
export function Table<Row>({ label, columns, rows, rowKey, onRowPress, empty = "Nothing here yet." }: {
  label: string; columns: Column<Row>[]; rows: readonly Row[]; rowKey: (row: Row) => string; onRowPress?: (row: Row) => void; empty?: string;
}) {
  if (!rows.length) return <p className="m-0 py-6 text-center text-sm text-chat-muted">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table aria-label={label} className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-chat-divider text-left text-chat-muted">
            {columns.map((c) => <th key={c.id} scope="col" className={`px-3 py-2 font-normal ${c.align === "right" ? "text-right" : ""}`}>{c.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)} className={`border-b border-chat-divider ${onRowPress ? "cursor-pointer hover:bg-chat-hover" : ""}`}
              {...(onRowPress && { onClick: () => onRowPress(row), tabIndex: 0, onKeyDown: (e) => { if (e.key === "Enter") onRowPress(row); } })}>
              {columns.map((c) => <td key={c.id} className={`px-3 py-2.5 ${c.align === "right" ? "text-right tabular-nums" : ""} ${c.className ?? ""}`}>{c.cell(row)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
