# Resolve Discord mentions in console notices

Console status and action notices now render channel mentions as readable Discord links, using the channel name when available. Unknown channels have a labeled ID. User and role mentions use readable fallback labels. Text is built with DOM text nodes so source content cannot introduce HTML.
