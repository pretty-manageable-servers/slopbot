# Recognize immediate follow-ups

After a delivered reply, Slopbot gives the same person's next messages a short follow-up prior. The classifier receives the recent reply reference. Eligible addressing scores gain up to 0.25, decaying to zero over 30 seconds. Low addressing scores and messages below the response threshold receive no boost. Another speaker ends the window.

`why` records the raw addressing score and the applied boost. Classifier thresholds, unsolicited reply caps and monitoring settings still apply.
