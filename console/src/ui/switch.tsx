import { Switch as AriaSwitch } from "react-aria-components";

interface SwitchProps {
  /** Name for screen readers. The row usually shows the text already, so the switch itself draws none. */
  label: string;
  /** Whether the switch is on. */
  checked: boolean;
  /** Called with the new state when the user flips it. */
  onChange: (on: boolean) => void;
  /** Grays the switch out and ignores input. */
  disabled?: boolean;
}

/** An on/off switch for a setting that applies at once. */
export function Switch({ label, checked, onChange, disabled }: SwitchProps) {
  return (
    <AriaSwitch aria-label={label} isSelected={checked} onChange={onChange} isDisabled={disabled ?? false} className="group inline-flex shrink-0 cursor-pointer items-center data-disabled:cursor-default data-disabled:opacity-50">
      <span className="flex h-5 w-9 items-center rounded-full bg-chat-border-strong p-0.5 transition-colors group-data-selected:bg-chat-accent group-data-focus-visible:outline-2 group-data-focus-visible:outline-chat-focus">
        <span className="size-4 rounded-full bg-chat-fg shadow transition-transform group-data-selected:translate-x-4 group-data-selected:bg-chat-accent-fg" />
      </span>
    </AriaSwitch>
  );
}
