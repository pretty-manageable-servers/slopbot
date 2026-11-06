// The components the model can use in show_ui markup. The bot uses these for the tool and the markup check;
// the web console (console/src/ui-components.tsx) adds a render for each name. No React here.
// The set and its wording follow the agentic-ui-kit playground set (apps/playground/src/lib/ui-components.tsx).
import { uiActionSchema, type UiComponentSpec } from "agentic-ui-kit/visuals/core";

const str = { type: "string" };
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const tone = { enum: ["default", "accent", "good", "warning", "bad"] };

export const showUiSpecs: UiComponentSpec[] = [
  {
    name: "Stack",
    description: "Lays out children in a column (or a wrapping row with direction 'row').",
    children: true,
    props: obj({ direction: { enum: ["column", "row"] }, gap: { enum: ["sm", "md", "lg"] } }),
  },
  {
    name: "Grid",
    description: "Children in equal columns (2-4) that stack on narrow screens.",
    children: true,
    props: obj({ columns: { type: "integer", minimum: 2, maximum: 4 } }),
  },
  {
    name: "Card",
    description: "A bordered box with an optional title, subtitle and tag. Highlight it with tone 'accent' when it is new or proposed.",
    children: true,
    props: obj({ title: str, subtitle: str, tag: str, tone: { enum: ["default", "accent"] } }),
  },
  { name: "Heading", description: "A section heading.", props: obj({ text: str }, ["text"]) },
  { name: "Text", description: "A paragraph of plain text; tone 'muted' for secondary notes.", props: obj({ text: str, tone: { enum: ["default", "muted"] } }, ["text"]) },
  {
    name: "Metric",
    description: "A key number with a label and an optional note, e.g. 'Total' '€184' 'per person'.",
    props: obj({ label: str, value: { type: ["string", "number"] }, note: str, tone }, ["label", "value"]),
  },
  {
    name: "List",
    description: "Rows with a label, an optional detail on the right and an optional tag ('New', 'Changed').",
    props: obj({ items: { type: "array", items: obj({ label: str, detail: str, tag: str }, ["label"]) } }, ["items"]),
  },
  {
    name: "Checklist",
    description: "Items the user ticks off; ticks stay in the widget's state under `stateKey`.",
    props: obj({ stateKey: str, items: { type: "array", items: str } }, ["stateKey", "items"]),
  },
  {
    name: "Tabs",
    description: "A row of choices that sets a state key; pair with Show to switch content. `value` reads the same key from state.",
    props: obj({ stateKey: str, value: str, options: { type: "array", items: obj({ id: str, label: str }, ["id", "label"]), minItems: 2 } }, ["stateKey", "options"]),
  },
  {
    name: "Show",
    description: "Shows its children only when `value` equals `equals`. `value` reads the state key; the first tab shows while the key is unset if `fallback` is true.",
    children: true,
    props: obj({ value: str, equals: str, fallback: { type: "boolean" } }, ["equals"]),
  },
  {
    name: "Button",
    description: "Runs an action. Use action 'set' for things the widget can do itself, 'send' only when you need to act.",
    props: obj({ label: str, variant: { enum: ["primary", "secondary"] }, onPress: uiActionSchema }, ["label", "onPress"]),
  },
];
