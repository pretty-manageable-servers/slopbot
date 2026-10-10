# Slopbot UX requirements

Slopbot should feel like part of the server's conversations. It follows context, remembers people, recognizes requests without a ping, and speaks when it has something worth adding. Admins control what it reads and how it participates.

## Message history and memory

- Index every message outside excluded channels in a vector database.
- Provide a slash command to index the server's existing message history.
- Let server admins select excluded channels.
- Update or remove indexed copies when someone edits or deletes a Discord message.
- Define what happens to previously indexed messages when an admin excludes a channel.

## Deciding when to participate

- Read every incoming message outside excluded channels.
- Use JEV, a very fast System 1 classification tool, to decide whether a message deserves a response. Slopbot should usually remain silent.
- When JEV monitoring is enabled, recognize requests addressed to Slopbot by name, even without an explicit mention.
- When JEV monitoring is disabled, respond only to explicit pings. Name-based requests without a ping are unreliable in this mode.
- Add a per-channel cooldown and a limit on unsolicited replies. Explicit requests to Slopbot bypass the cooldown.

## Replies and reactions

- When JEV selects a message, let an LLM choose an emoji reaction or a reply.
- Recognize humor using the preceding conversation.
- Use a system prompt that keeps replies concise and removes AI writing patterns.

## GIF understanding

- Provide tooling that helps JEV and the LLM understand incoming GIFs.
- When a message contains a GIF, trigger a preprocessing step that extracts a few different frames.
- Have an LLM inspect those frames, determine what is happening in the GIF, and summarize it.
- Add the summary to the message context before passing it to JEV. Make the summary available to the reply LLM as well.

## Configuration and permissions

- Make configuration easy for authorized users within the server.
- Configure how many preceding messages JEV receives when deciding whether to participate.
- Configure how many preceding messages the reply LLM receives when composing a response.
- Allow authorized users to turn JEV monitoring on or off.
- Define permission levels that determine who can change settings.
- Define which settings apply to individual servers and which apply across Slopbot.
- Give admins a command to inspect why Slopbot replied or stayed silent, including the effects of monitoring settings, channel exclusions, and cooldowns. Keep this information out of ordinary conversation.

## User profiles

- Store user information in structured records.
- Support both user-specific information and server-specific information about a user.
- Support real names, nicknames, and links such as GitHub or LinkedIn profiles.
- Allow flexible additional fields about a person.
- Let anyone add or edit information about another user by default.
- Let profile owners disable edits by other users.
- Record who changed each profile field and let the profile owner undo changes.

## Profile access and updates

- Make stored profile information transparent. Provide a slash command that lets each person dump their own profile. Post the dump publicly so the whole server can see it.
- Provide slash commands that change profile fields deterministically.
- Accept profile updates through conversation, such as asking Slopbot to add information about someone.
- Let Slopbot find a person by name or nickname and retrieve their full profile.

One proposed lookup approach is to index profile information in the vector database. The LLM searches for a nickname such as "teddio", retrieves the matching user ID, then uses a tool to fetch that user's full structured profile.

## Response presentation

Ordinary conversation and agentic requests need different response behavior.

- For ordinary replies, show Discord's typing indicator and send the reply as soon as it is ready. Avoid messages such as "thinking" or "generating".
- For agentic requests, allow progress updates and put tool calls in threads, since a request may involve many calls.




ordinary replies should just be messages, but replies to agentic replies should happen inside a thread, since those are going to be very long blob of text
deeper dive of that thread can be continued within the thread
the top level chat can be one giant thread, or it could be a fresh request to a fresh chat everytime we decide llm to talk