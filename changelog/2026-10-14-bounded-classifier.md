# Bound participation classifier input

Both participation classifiers now receive at most five preceding messages and an 8 KiB conversational payload. Long message text is shortened; attachment URLs, model images, uploads and profile metadata are excluded. The current message and recent author, reply and bot identity cues remain available.

JEV defaults to five messages. Older larger settings are clamped, and the context command reports its effective limit. No lexical pre-gate drops short messages, questions or follow-ups. Provider latency still depends on the service; this change bounds input cost rather than promising a response time.
