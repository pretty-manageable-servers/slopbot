# Make shared reply details explicit

The channel-share dialog now labels its option "Include Slopbot reasoning and tool activity". Turning it on includes reasoning and the tool-call list. Turning it off excludes both. Tool arguments and results remain excluded from shared pages.

Shared-page markdown rendering was already implemented. Browser-script tests now verify formatted bold text, lists, inline and fenced code, links, reasoning and tool activity together.
